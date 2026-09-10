import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";

export class HostProcessPlatform extends Context.Reference<HostProcessPlatform>()(
  "@home-server/shared/hostProcess/HostProcessPlatform",
  { defaultValue: () => process.platform as NodeJS.Platform },
) {}

export class HostProcessArchitecture extends Context.Reference<HostProcessArchitecture>()(
  "@home-server/shared/hostProcess/HostProcessArchitecture",
  { defaultValue: () => process.arch as NodeJS.Architecture },
) {}

export class HostProcessHostname extends Context.Reference<HostProcessHostname>()(
  "@home-server/shared/hostProcess/HostProcessHostname",
  { defaultValue: () => NodeOS.hostname() },
) {}

export class HostProcessEnvironment extends Context.Reference<HostProcessEnvironment>()(
  "@home-server/shared/hostProcess/HostProcessEnvironment",
  { defaultValue: () => process.env },
) {}

export class HostProcessWorkingDirectory extends Context.Reference<HostProcessWorkingDirectory>()(
  "@home-server/shared/hostProcess/HostProcessWorkingDirectory",
  { defaultValue: () => process.cwd() },
) {}

export class HostProcessExecutablePath extends Context.Reference<HostProcessExecutablePath>()(
  "@home-server/shared/hostProcess/HostProcessExecutablePath",
  { defaultValue: () => process.execPath },
) {}

export class HostProcessArguments extends Context.Reference<HostProcessArguments>()(
  "@home-server/shared/hostProcess/HostProcessArguments",
  { defaultValue: () => process.argv as ReadonlyArray<string> },
) {}

/** Undefined on platforms without POSIX uids (Windows). */
export class HostProcessUserId extends Context.Reference<HostProcessUserId>()(
  "@home-server/shared/hostProcess/HostProcessUserId",
  { defaultValue: () => process.getuid?.() as number | undefined },
) {}

export const isHostWindows = Effect.map(HostProcessPlatform, (platform) => platform === "win32");
