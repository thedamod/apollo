import {
  FilesystemBrowseInput,
  FilesystemPathInput,
  FilesystemReadInput,
  FilesystemMkdirInput,
  FilesystemRenameInput,
  FilesystemDeleteInput,
  RpcMethod,
} from "@home-server/contracts";
import type { RpcRegistry } from "../registry.ts";
import type { FilesystemService } from "../../services/filesystem.ts";

export function registerFilesystemHandlers(reg: RpcRegistry, fs: FilesystemService): void {
  reg.registerZod(RpcMethod.filesystemBrowse, FilesystemBrowseInput, async (params) => {
    return fs.browse(params as FilesystemBrowseInput);
  });
  reg.registerZod(RpcMethod.filesystemStat, FilesystemPathInput, async (params) => {
    return fs.stat(params as FilesystemPathInput);
  });
  reg.registerZod(RpcMethod.filesystemReadFile, FilesystemReadInput, async (params) => {
    return fs.readFile(params as FilesystemReadInput);
  });
  reg.registerZod(RpcMethod.filesystemMkdir, FilesystemMkdirInput, async (params) => {
    return fs.mkdir(params as FilesystemMkdirInput);
  });
  reg.registerZod(RpcMethod.filesystemRename, FilesystemRenameInput, async (params) => {
    return fs.rename(params as FilesystemRenameInput);
  });
  reg.registerZod(RpcMethod.filesystemDelete, FilesystemDeleteInput, async (params) => {
    return fs.remove(params as FilesystemDeleteInput);
  });
}
