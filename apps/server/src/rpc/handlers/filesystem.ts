import { FilesystemBrowseInput, RpcMethod } from "@home-server/contracts";
import type { RpcRegistry } from "../registry.ts";
import type { FilesystemService } from "../../services/filesystem.ts";

export function registerFilesystemHandlers(reg: RpcRegistry, fs: FilesystemService): void {
  reg.registerZod(RpcMethod.filesystemBrowse, FilesystemBrowseInput, async (params) => {
    return fs.browse(params as FilesystemBrowseInput);
  });
}
