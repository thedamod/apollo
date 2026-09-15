import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FilesystemService, resolveSharePath } from "./services/filesystem.ts";
import { createWebDavRouter } from "./webdav.ts";
import type { WebDavShare } from "./config.ts";

const TOKEN = "hs_test_token_0123456789abcdef";

let root: string;
let mediaDir: string;
let roDir: string;
let baseUrl: string;
let server: http.Server;
const fss = new FilesystemService();

const shares: WebDavShare[] = [
  { name: "media", path: "", readOnly: false },
  { name: "ro", path: "", readOnly: true },
];

function authHeaders(
  kind: "bearer" | "basic" | "query" | "none" = "bearer",
): Record<string, string> {
  if (kind === "bearer") return { authorization: `Bearer ${TOKEN}` };
  if (kind === "basic")
    return {
      authorization: `Basic ${Buffer.from(`finder:${TOKEN}`).toString("base64")}`,
    };
  return {};
}

async function dav(
  method: string,
  p: string,
  init: RequestInit & { auth?: "bearer" | "basic" | "query" | "none" } = {},
) {
  const { auth = "bearer", headers: extraHeaders, ...rest } = init;
  const sep = p.includes("?") ? "&" : "?";
  const url =
    auth === "query" ? `${baseUrl}${p}${sep}token=${TOKEN}` : `${baseUrl}${p}`;
  const base = auth === "query" || auth === "none" ? {} : authHeaders(auth);
  return fetch(url, {
    method,
    ...rest,
    headers: {
      ...base,
      ...(extraHeaders as Record<string, string> | undefined),
    },
  });
}

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "dav-test-"));
  mediaDir = path.join(root, "media");
  roDir = path.join(root, "ro");
  await fsp.mkdir(mediaDir, { recursive: true });
  await fsp.mkdir(roDir, { recursive: true });
  await fsp.writeFile(path.join(mediaDir, "hello.txt"), "hello world");
  await fsp.mkdir(path.join(mediaDir, "sub"), { recursive: true });
  await fsp.writeFile(path.join(mediaDir, "sub", "nested.txt"), "nested");
  shares[0]!.path = mediaDir;
  shares[1]!.path = roDir;

  const app = express();
  app.use(
    "/dav",
    createWebDavRouter({
      token: TOKEN,
      filesystemService: fss,
      getShares: () => shares,
    }),
  );
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fsp.rm(root, { recursive: true, force: true });
});

describe("webdav auth", () => {
  it("rejects unauthenticated requests with Basic challenge", async () => {
    const res = await dav("PROPFIND", "/dav/", {
      auth: "none",
      headers: { Depth: "0" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'Basic realm="home server"',
    );
  });

  it("accepts Bearer, Basic (user ignored), and ?token= fallback", async () => {
    for (const auth of ["bearer", "basic", "query"] as const) {
      const res = await dav("PROPFIND", "/dav/", {
        auth,
        headers: { Depth: "0" },
      });
      expect(res.status).toBe(207);
    }
  });

  it("rejects wrong Basic password", async () => {
    const res = await fetch(`${baseUrl}/dav/`, {
      method: "PROPFIND",
      headers: {
        authorization: `Basic ${Buffer.from("finder:wrong").toString("base64")}`,
        Depth: "0",
      },
    });
    expect(res.status).toBe(401);
  });
});

describe("webdav browse (finder connect/open probes)", () => {
  it("PROPFIND depth 0 on /dav works (finder connect)", async () => {
    const res = await dav("PROPFIND", "/dav/", { headers: { Depth: "0" } });
    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(xml).toContain("multistatus");
    expect(xml).toContain("<D:href>/dav/</D:href>");
  });

  it("PROPFIND depth 1 on /dav lists shares", async () => {
    const res = await dav("PROPFIND", "/dav/", { headers: { Depth: "1" } });
    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(xml).toContain("/dav/media/");
    expect(xml).toContain("/dav/ro/");
  });

  it("PROPFIND depth 1 on share lists children (finder open)", async () => {
    const res = await dav("PROPFIND", "/dav/media/", {
      headers: { Depth: "1" },
    });
    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(xml).toContain("hello.txt");
    expect(xml).toContain("collection");
  });

  it("PROPFIND infinity recurses", async () => {
    const res = await dav("PROPFIND", "/dav/media/", {
      headers: { Depth: "infinity" },
    });
    expect(res.status).toBe(207);
    expect(await res.text()).toContain("nested.txt");
  });

  it("PROPFIND missing path is 404", async () => {
    const res = await dav("PROPFIND", "/dav/media/nope.txt", {
      headers: { Depth: "0" },
    });
    expect(res.status).toBe(404);
  });
});

describe("webdav file transfer", () => {
  it("GET serves bytes with etag + ranges", async () => {
    const res = await dav("GET", "/dav/media/hello.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(res.headers.get("etag")).toBeTruthy();
    expect(await res.text()).toBe("hello world");
  });

  it("GET range returns 206", async () => {
    const res = await dav("GET", "/dav/media/hello.txt", {
      headers: { Range: "bytes=0-4" },
    });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("hello");
  });

  it("HEAD returns headers without body", async () => {
    const res = await dav("HEAD", "/dav/media/hello.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("11");
    expect(await res.text()).toBe("");
  });

  it("GET on a collection or /dav itself is refused", async () => {
    expect((await dav("GET", "/dav/media/")).status).toBe(403);
    expect((await dav("GET", "/dav/")).status).toBe(403);
  });
});

describe("webdav writes", () => {
  it("PUT creates parent dirs, MKCOL + DELETE round-trip", async () => {
    const put = await dav("PUT", "/dav/media/newdir/a.txt", { body: "data" });
    expect([201, 204]).toContain(put.status);
    expect(await (await dav("GET", "/dav/media/newdir/a.txt")).text()).toBe(
      "data",
    );

    const mk = await dav("MKCOL", "/dav/media/emptydir");
    expect(mk.status).toBe(201);
    expect((await dav("MKCOL", "/dav/media/emptydir")).status).toBe(405);

    const del = await dav("DELETE", "/dav/media/newdir");
    expect(del.status).toBe(204);
    expect((await dav("GET", "/dav/media/newdir/a.txt")).status).toBe(404);
  });

  it("MOVE renames and COPY duplicates", async () => {
    await dav("PUT", "/dav/media/move-me.txt", { body: "mv" });
    const mv = await dav("MOVE", "/dav/media/move-me.txt", {
      headers: { Destination: `${baseUrl}/dav/media/moved.txt` },
    });
    expect([201, 204]).toContain(mv.status);
    expect((await dav("GET", "/dav/media/move-me.txt")).status).toBe(404);
    expect(await (await dav("GET", "/dav/media/moved.txt")).text()).toBe("mv");

    const cp = await dav("COPY", "/dav/media/moved.txt", {
      headers: { Destination: `${baseUrl}/dav/media/copied.txt` },
    });
    expect([201, 204]).toContain(cp.status);
    expect(await (await dav("GET", "/dav/media/copied.txt")).text()).toBe("mv");
  });

  it("COPY with Overwrite: F on existing destination is 412", async () => {
    const res = await dav("COPY", "/dav/media/moved.txt", {
      headers: {
        Destination: `${baseUrl}/dav/media/copied.txt`,
        Overwrite: "F",
      },
    });
    expect(res.status).toBe(412);
  });

  it("PROPPATCH is a 200 no-op and LOCK/UNLOCK fake success", async () => {
    const pp = await dav("PROPPATCH", "/dav/media/hello.txt", {
      headers: { "Content-Type": "application/xml" },
      body: `<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:foo>bar</D:foo></D:prop></D:set></D:propertyupdate>`,
    });
    expect(pp.status).toBe(207);

    const lock = await dav("LOCK", "/dav/media/hello.txt");
    expect(lock.status).toBe(200);
    expect(lock.headers.get("lock-token")).toContain("opaquelocktoken:");
    expect((await dav("UNLOCK", "/dav/media/hello.txt")).status).toBe(204);
  });
});

describe("webdav read-only shares", () => {
  it("refuses PUT/MKCOL/DELETE with 403 but serves reads", async () => {
    expect((await dav("PUT", "/dav/ro/a.txt", { body: "x" })).status).toBe(403);
    expect((await dav("MKCOL", "/dav/ro/d")).status).toBe(403);
    expect((await dav("DELETE", "/dav/ro/")).status).toBe(403);
    expect(
      (await dav("PROPFIND", "/dav/ro/", { headers: { Depth: "0" } })).status,
    ).toBe(207);
  });
});

describe("webdav confinement", () => {
  it("resolveSharePath rejects reversal", () => {
    expect(() => resolveSharePath(mediaDir, "../outside")).toThrow();
    expect(() => resolveSharePath(mediaDir, "a/../../outside")).toThrow();
    expect(resolveSharePath(mediaDir, "a/b")).toBe(path.join(mediaDir, "a/b"));
  });

  it("symlink pointing outside the share is listed but not served", async () => {
    const outside = path.join(root, "secret.txt");
    await fsp.writeFile(outside, "secret");
    await fsp
      .symlink(outside, path.join(mediaDir, "evil-link"))
      .catch(() => {});
    const list = await dav("PROPFIND", "/dav/media/", {
      headers: { Depth: "1" },
    });
    expect(await list.text()).toContain("evil-link");
    expect((await dav("GET", "/dav/media/evil-link")).status).toBe(403);
  });
});

describe("filesystem copy", () => {
  it("copies a file and refuses overwrite without flag", async () => {
    const from = path.join(root, "copy-src.txt");
    const to = path.join(root, "copy-dst.txt");
    await fsp.writeFile(from, "copy me");
    await fss.copy({ from, to });
    expect(await fsp.readFile(to, "utf8")).toBe("copy me");
    await expect(fss.copy({ from, to })).rejects.toMatchObject({
      code: "already_exists",
    });
    await fss.copy({ from, to, overwrite: true });
  });

  it("copies directories recursively and links as links", async () => {
    const srcDir = path.join(root, "copytree");
    await fsp.mkdir(path.join(srcDir, "inner"), { recursive: true });
    await fsp.writeFile(path.join(srcDir, "inner", "f.txt"), "deep");
    const dstDir = path.join(root, "copytree2");
    await fss.copy({ from: srcDir, to: dstDir });
    expect(
      await fsp.readFile(path.join(dstDir, "inner", "f.txt"), "utf8"),
    ).toBe("deep");
  });
});
