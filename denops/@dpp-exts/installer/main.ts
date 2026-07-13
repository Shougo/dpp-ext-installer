import type {
  BaseParams,
  Context,
  DppOptions,
  ExtOptions,
  Plugin,
  ProtocolName,
} from "@shougo/dpp-vim/types";
import { type Action, BaseExt } from "@shougo/dpp-vim/ext";
import type { Protocol } from "@shougo/dpp-vim/protocol";
import {
  convert2List,
  isDirectory,
  printError,
  safeStat,
} from "@shougo/dpp-vim/utils";

import type { Denops } from "@denops/std";
import { batch } from "@denops/std/batch";
import * as autocmd from "@denops/std/autocmd";
import * as op from "@denops/std/option";
import * as fn from "@denops/std/function";
import * as vars from "@denops/std/variable";

import { delay } from "@std/async/delay";
import { Semaphore } from "@core/asyncutil/semaphore";
import {
  dateDiffDays,
  getFormattedDate,
  pipeStream,
  timeAgo,
} from "./utils.ts";

export type Params = {
  checkDiff: boolean;
  checkExts: string[];
  logFilePath: string;
  maxInactiveDays: number;
  maxProcesses: number;
  minCommitDays: number;
  wait: number;
};

export type Attrs = {
  installerBuild?: string;
  installerFrozen?: boolean;
  installerMaxInactiveDays?: number;
  installerMinCommitDays?: number;
};

export type InstallParams = {
  names?: string[];
  rollback?: string;
};

export type CheckParams = {
  force?: boolean;
  names?: string[];
};

type UpdatedPlugin = {
  plugin: Plugin;
  protocol: Protocol;
  newRev: string;
  oldRev: string;
  newRevDate: Date | null;
  oldRevDate: Date | null;
  url: string;
  logMessage: string;
  changesCount: number;
};

type CheckUpdatedPlugin = {
  count?: number;
  plugin: Plugin;
  updated?: Date;
};

type CheckedPlugin = UpdatedPlugin & {
  histories: string[];
};

type Rollback = {
  name: string;
  updateDate?: Date;
  newRev: string;
  oldRev?: string;
  newRevDate: Date | null;
  oldRevDate?: Date | null;
};
type Rollbacks = Record<string, Rollback>;

type CheckHistory = {
  name: string;
  checkDate: Date;
  newRev: string;
  oldRev?: string;
  newRevDate: Date | null;
  oldRevDate?: Date | null;
  histories: string[];
};
type CheckHistories = Record<string, CheckHistory>;

export type ExtActions<Params extends BaseParams> = {
  build: Action<Params, void>;
  checkNotUpdated: Action<Params, void>;
  denoCache: Action<Params, void>;
  getFailed: Action<Params, Plugin[]>;
  getLogs: Action<Params, string[]>;
  getNotInstalled: Action<Params, Plugin[]>;
  getNotUpdated: Action<Params, Plugin[]>;
  getUpdateLogs: Action<Params, string[]>;
  getUpdated: Action<Params, Plugin[]>;
  install: Action<Params, void>;
  reinstall: Action<Params, void>;
  update: Action<Params, void>;
};

export class Ext extends BaseExt<Params> {
  #failedPlugins: Plugin[] = [];
  #logs: string[] = [];
  #updateLogs: string[] = [];
  #updatedPlugins: Plugin[] = [];
  #cachedLogFilePathParam: string | null = null;
  #cachedLogFilePath: string | null = null;
  // Log buffering
  #logBuffer: string[] = [];
  #logFlushTimer: number | null = null;
  #logFlushing = false;
  #logFlushIntervalMs = 500;

  override async onInit(args: {
    denops: Denops;
  }) {
    await autocmd.group(args.denops, "dpp", (helper: autocmd.GroupHelper) => {
      helper.define(
        "User",
        "Dpp:ext:installer:updateDone",
        ":",
      );
    });
  }

  override actions: ExtActions<Params> = {
    build: {
      description: "Build plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as InstallParams;

        const plugins = await getPlugins(args.denops, params.names ?? []);

        const sem = new Semaphore(args.extParams.maxProcesses);
        await Promise.all(plugins.map((plugin) =>
          sem.lock(async () => {
            await this.#buildPlugin(args.denops, args.extParams, plugin);
          })
        ));
      },
    },
    checkNotUpdated: {
      description: "Check not updated plugins",
      callback: async (args: {
        denops: Denops;
        context: Context;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extOptions: ExtOptions;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as CheckParams;
        const plugins = await getPlugins(args.denops, params.names ?? []);
        const checkPlugins = plugins.filter((plugin) =>
          !(plugin.extAttrs as Attrs)?.installerFrozen
        );

        const checked = await this.#checkRemotePlugins(
          args,
          checkPlugins,
        );

        await this.#promptAndUpdate(args, checked, params);
      },
    },
    denoCache: {
      description: "Execute deno cache for plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as InstallParams;

        const plugins = await getPlugins(args.denops, params.names ?? []);

        await this.#denoCachePlugins(args.denops, args.extParams, plugins);
      },
    },
    getFailed: {
      description: "Get failed plugins",
      callback: (_args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: BaseParams;
      }) => {
        return this.#failedPlugins;
      },
    },
    getLogs: {
      description: "Get logs",
      callback: (_args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: BaseParams;
      }) => {
        return this.#logs;
      },
    },
    getNotInstalled: {
      description: "Get not installed plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as InstallParams;
        const plugins = await getPlugins(args.denops, params.names ?? []);

        const bits = await Promise.all(
          plugins.map(async (plugin) =>
            plugin.path && !await isDirectory(plugin.path)
          ),
        );

        return plugins.filter((_, i) => bits[i]);
      },
    },
    getNotUpdated: {
      description: "Get not updated plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as InstallParams;
        const plugins = await getPlugins(args.denops, params.names ?? []);
        const checkPlugins = plugins.filter((plugin) =>
          !(plugin.extAttrs as Attrs)?.installerFrozen
        );
        const notUpdatedPlugins = (await this.#checkRemotePlugins(
          args,
          checkPlugins,
        )).map((updated) => updated.plugin);

        return notUpdatedPlugins;
      },
    },
    getUpdateLogs: {
      description: "Get update logs",
      callback: (_args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: BaseParams;
      }) => {
        return this.#updateLogs;
      },
    },
    getUpdated: {
      description: "Get updated plugins",
      callback: (_args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: BaseParams;
      }) => {
        return this.#updatedPlugins;
      },
    },
    install: {
      description: "Install plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as InstallParams;
        const names = params.names ?? [];
        const allPlugins = names.length === 0;
        const plugins = await getPlugins(args.denops, names);

        const bits = await Promise.all(
          plugins.map(async (plugin) =>
            plugin.path && !await isDirectory(plugin.path)
          ),
        );

        const rollbacks = params.rollback
          ? await loadRollbacks(args.denops, params.rollback)
          : {};

        await this.#updatePlugins(
          args,
          plugins.filter((_, i) => bits[i]),
          rollbacks,
          allPlugins,
        );
      },
    },
    reinstall: {
      description: "Reinstall plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as InstallParams;
        if (!params.names || params.names.length === 0) {
          // NOTE: names must be set.
          await this.#printError(
            args.denops,
            args.extParams,
            "names must be set for reinstall plugins.",
          );
          return;
        }

        const names = params.names ?? [];
        const allPlugins = names.length === 0;
        const plugins = await getPlugins(args.denops, names);

        const rollbacks = params.rollback
          ? await loadRollbacks(args.denops, params.rollback)
          : {};

        await Promise.all(plugins.map(async (plugin) => {
          // Remove plugin directory
          if (plugin.path && await isDirectory(plugin.path)) {
            try {
              await Deno.remove(plugin.path, { recursive: true });
            } catch (e) {
              await this.#printError(
                args.denops,
                args.extParams,
                `Failed to remove plugin directory: ${plugin.path}: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
            }
          }
        }));

        await this.#updatePlugins(
          args,
          plugins,
          rollbacks,
          allPlugins,
        );
      },
    },
    update: {
      description: "Update plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        extParams: Params;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as InstallParams;
        const names = params.names ?? [];
        const allPlugins = names.length === 0;
        const plugins = await getPlugins(args.denops, names);

        const rollbacks = params.rollback
          ? await loadRollbacks(args.denops, params.rollback)
          : {};

        const updatePlugins = plugins.filter((plugin) =>
          !(plugin.extAttrs as Attrs)?.installerFrozen
        );

        await this.#updatePlugins(
          args,
          updatePlugins,
          rollbacks,
          allPlugins,
        );
      },
    },
  };

  override params(): Params {
    return {
      checkDiff: false,
      checkExts: ["zip"],
      logFilePath: "",
      maxProcesses: 5,
      maxInactiveDays: 180,
      minCommitDays: 0,
      wait: 0,
    };
  }

  async #updatePlugins(
    args: {
      denops: Denops;
      options: DppOptions;
      protocols: Record<ProtocolName, Protocol>;
      extParams: Params;
      actionParams: BaseParams;
    },
    plugins: Plugin[],
    rollbacks: Rollbacks,
    allPlugins: boolean,
  ) {
    this.#failedPlugins = [];
    this.#logs = [];
    this.#updatedPlugins = [];
    this.#updateLogs = [];

    if (plugins.length === 0) {
      await this.#printError(
        args.denops,
        args.extParams,
        "Target plugins are not found.",
      );
      await this.#printError(
        args.denops,
        args.extParams,
        "You may have used the wrong plugin name," +
          " or all of the plugins are already installed.",
      );

      await args.denops.cmd(
        "doautocmd User Dpp:ext:installer:updateDone",
      );

      return;
    }

    await this.#printMessage(
      args.denops,
      args.extParams,
      `Start: ${new Date()}`,
    );

    const latestRollbacks = await loadRollbacks(args.denops, "latest");
    const checkHistories = await loadCheckHistories(args.denops);

    const updatedPlugins: UpdatedPlugin[] = [];
    const failedPlugins: Plugin[] = [];
    const sem = new Semaphore(args.extParams.maxProcesses);
    await Promise.all(plugins.map((plugin, index) =>
      sem.lock(async () => {
        await this.#updatePlugin(
          args,
          updatedPlugins,
          failedPlugins,
          latestRollbacks,
          rollbacks,
          checkHistories,
          plugins.length,
          allPlugins,
          plugin,
          index + 1,
        );

        if (args.extParams.wait > 0) {
          await delay(args.extParams.wait);
        }
      })
    ));

    const calledDepends: Record<string, boolean> = {};
    for (const updated of updatedPlugins) {
      if (updated.plugin.hook_done_update) {
        await args.denops.call(
          "dpp#ext#installer#_call_hook",
          "done_update",
          updated.plugin,
        );
      }

      for (
        const depend of await getPlugins(
          args.denops,
          convert2List(updated.plugin.depends),
        )
      ) {
        if (depend.hook_depends_update && !calledDepends[depend.name]) {
          calledDepends[depend.name] = true;

          await args.denops.call(
            "dpp#ext#installer#_call_hook",
            "depends_update",
            depend,
          );
        }
      }

      await this.#checkDiff(
        args.denops,
        args.extParams,
        updated.plugin,
        updated.protocol,
        updated.oldRev,
        updated.newRev,
      );
    }

    if (updatedPlugins.length > 0) {
      await this.#printUpdatedPlugins(
        args.denops,
        args.extParams,
        updatedPlugins,
      );

      await saveRollbackFile(args.denops, args.protocols, updatedPlugins);
    }

    if (failedPlugins.length > 0) {
      await this.#printMessage(
        args.denops,
        args.extParams,
        "Failed plugins:\n" +
          `${failedPlugins.map((plugin) => plugin.name).join("\n")}\n` +
          "Please read the error message log with the :message command.",
      );
    }

    this.#updatedPlugins = updatedPlugins.map((plugin) => plugin.plugin);
    this.#failedPlugins = failedPlugins;

    await args.denops.call("dpp#ext#installer#_close_progress_window");

    await args.denops.call("dpp#make_state");

    // NOTE: "redraw" is needed to close popup window
    await args.denops.cmd("redraw");

    await this.#printMessage(
      args.denops,
      args.extParams,
      `Done: ${new Date()}`,
    );

    await args.denops.cmd(
      "doautocmd User Dpp:ext:installer:updateDone",
    );
  }

  async #updatePlugin(
    args: {
      denops: Denops;
      options: DppOptions;
      protocols: Record<ProtocolName, Protocol>;
      extParams: Params;
      actionParams: BaseParams;
    },
    updatedPlugins: UpdatedPlugin[],
    failedPlugins: Plugin[],
    latestRollbacks: Rollbacks,
    rollbacks: Rollbacks,
    checkHistories: CheckHistories,
    maxLength: number,
    allPlugins: boolean,
    plugin: Plugin,
    index: number,
  ) {
    await this.#printProgress(
      args.denops,
      args.extParams,
      `[${index}/${maxLength}] ${plugin.name}`,
    );

    if (plugin.local) {
      await this.#printMessage(
        args.denops,
        args.extParams,
        `"${plugin.name}" is local plugin.  The update is skipped.`,
      );

      return;
    }

    const protocolName = plugin.protocol ?? "";
    if (protocolName.length === 0) {
      return;
    }
    const protocol = args.protocols[protocolName];

    const oldRev = await protocol.protocol.getRevision({
      denops: args.denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
    });

    if (plugin.rev) {
      // Force checkout HEAD revision.
      // The repository may be checked out.
      const saveRev = plugin.rev;

      plugin.rev = "";

      await this.#revisionLockPlugin(
        args.denops,
        args.extParams,
        plugin,
        protocol,
      );

      plugin.rev = saveRev;
    }

    const commands = await protocol.protocol.getSyncCommands({
      denops: args.denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
    });

    if (rollbacks[plugin.name]) {
      // Add rollback commands
      commands.push(
        ...await protocol.protocol.getRollbackCommands({
          denops: args.denops,
          plugin,
          protocolOptions: protocol.options,
          protocolParams: protocol.params,
          rev: rollbacks[plugin.name].newRev,
        }),
      );
    }

    if (plugin.hook_pre_update) {
      await args.denops.call(
        "dpp#ext#installer#_call_hook",
        "pre_update",
        plugin,
      );
    }

    // Execute commands
    let updateSuccess = commands.length !== 0;

    for (const command of commands) {
      const { success, code } = await this.#runCommand(
        args.denops,
        args.extParams,
        plugin,
        command,
        this.#printProgress.bind(this, args.denops, args.extParams),
      );
      if (!success) {
        await this.#printError(
          args.denops,
          args.extParams,
          `Command failed with exit code ${code}: ${command.command}`,
        );
        updateSuccess = false;
        break;
      }
    }

    if (plugin.rev) {
      // Restore revision
      await this.#revisionLockPlugin(
        args.denops,
        args.extParams,
        plugin,
        protocol,
      );
    }

    if (updateSuccess) {
      const newRev = await protocol.protocol.getRevision({
        denops: args.denops,
        plugin,
        protocolOptions: protocol.options,
        protocolParams: protocol.params,
      });

      if (newRev.length > 0) {
        if (plugin.rev && plugin.rev !== newRev) {
          await this.#printMessage(
            args.denops,
            args.extParams,
            `${plugin.name}: revision is changed.\n` +
              `  Current commit:  ${newRev}`,
          );
        }

        if (!allPlugins && !plugin.rev && newRev === oldRev) {
          await this.#printMessage(
            args.denops,
            args.extParams,
            `${plugin.name}: revision is unchanged.\n` +
              `  Current commit:  ${newRev}`,
          );
        }
      }

      const logMessage = await this.#getLogMessage(
        args.denops,
        args.extParams,
        plugin,
        protocol,
        oldRev,
        newRev,
      );

      const changesCount = await this.#getChangesCount(
        args.denops,
        args.extParams,
        plugin,
        protocol,
        oldRev,
        newRev,
      );

      if (oldRev.length === 0 || newRev !== oldRev) {
        // Execute "post_update" before "build"
        if (plugin.hook_post_update) {
          await args.denops.call(
            "dpp#ext#installer#_call_hook",
            "post_update",
            plugin,
          );
        }

        await this.#buildPlugin(args.denops, args.extParams, plugin);

        const matches = await checkInstalledFiles(args.extParams, plugin);
        if (matches.length > 0) {
          const details = matches
            .slice(0, 5)
            .map((m) => `${m.line}:${m.column} ${m.url}`)
            .join("\n");

          await this.#printError(
            args.denops,
            args.extParams,
            `${plugin.name}: installed files check failed.\n${details}`,
          );
          failedPlugins.push(plugin);
          return;
        }

        const url = await protocol.protocol.getUrl({
          denops: args.denops,
          plugin,
          protocolOptions: protocol.options,
          protocolParams: protocol.params,
        });

        const [oldRevDate, newRevDate] = await Promise.all([
          protocol.protocol.getDateFromRevision({
            denops: args.denops,
            plugin,
            protocolOptions: protocol.options,
            protocolParams: protocol.params,
            rev: oldRev,
          }),
          protocol.protocol.getDateFromRevision({
            denops: args.denops,
            plugin,
            protocolOptions: protocol.options,
            protocolParams: protocol.params,
            rev: newRev,
          }),
        ]);

        // NOTE: Print warnings if the commit days are invalid.
        if (
          await checkPluginCommits(
            args.denops,
            args.extParams,
            protocol,
            latestRollbacks,
            checkHistories,
            plugin,
            oldRev,
            newRev,
            oldRevDate,
            newRevDate,
          )
        ) {
          failedPlugins.push(plugin);
          return;
        }

        updatedPlugins.push({
          plugin,
          protocol,
          oldRev,
          newRev,
          oldRevDate,
          newRevDate,
          url,
          logMessage,
          changesCount,
        });
      }
    } else {
      failedPlugins.push(plugin);
    }
  }

  async #checkRemotePlugins(
    args: {
      denops: Denops;
      options: DppOptions;
      protocols: Record<ProtocolName, Protocol>;
      extParams: Params;
      actionParams: BaseParams;
    },
    plugins: Plugin[],
  ): Promise<CheckUpdatedPlugin[]> {
    if (plugins.length === 0) {
      await this.#printError(
        args.denops,
        args.extParams,
        "Target plugins are not found.",
      );
      await this.#printError(
        args.denops,
        args.extParams,
        "You may have used the wrong plugin name," +
          " or all of the plugins are already installed.",
      );

      return [];
    }

    await this.#printMessage(
      args.denops,
      args.extParams,
      `Start: ${new Date()}`,
    );

    const latestRollbacks = await loadRollbacks(args.denops, "latest");
    const checkHistories = await loadCheckHistories(args.denops);

    const updatedPlugins: UpdatedPlugin[] = [];
    const checkedPlugins: CheckedPlugin[] = [];
    const sem = new Semaphore(args.extParams.maxProcesses);
    await Promise.all(plugins.map((plugin, index) =>
      sem.lock(async () => {
        await this.#checkRemotePlugin(
          args,
          updatedPlugins,
          checkedPlugins,
          latestRollbacks,
          checkHistories,
          plugins.length,
          plugin,
          index + 1,
        );

        if (args.extParams.wait > 0) {
          await delay(args.extParams.wait);
        }
      })
    ));

    if (updatedPlugins.length > 0) {
      await this.#printUpdatedPlugins(
        args.denops,
        args.extParams,
        updatedPlugins,
      );
    }

    await saveCheckHistories(args.denops, checkedPlugins);

    await args.denops.call("dpp#ext#installer#_close_progress_window");

    // NOTE: "redraw" is needed to close popup window
    await args.denops.cmd("redraw");

    await this.#printMessage(
      args.denops,
      args.extParams,
      `Done: ${new Date()}`,
    );

    return updatedPlugins.map((plugin) => {
      return { plugin: plugin.plugin, count: plugin.changesCount };
    });
  }

  async #checkRemotePlugin(
    args: {
      denops: Denops;
      options: DppOptions;
      protocols: Record<ProtocolName, Protocol>;
      extParams: Params;
      actionParams: BaseParams;
    },
    updatedPlugins: UpdatedPlugin[],
    checkedPlugins: CheckedPlugin[],
    latestRollbacks: Rollbacks,
    checkHistories: CheckHistories,
    maxLength: number,
    plugin: Plugin,
    index: number,
  ) {
    await this.#printProgress(
      args.denops,
      args.extParams,
      `[${index}/${maxLength}] ${plugin.name}`,
    );

    if (plugin.local) {
      return;
    }

    const protocolName = plugin.protocol ?? "";
    if (protocolName.length === 0) {
      return;
    }
    const protocol = args.protocols[protocolName];

    const commands = await protocol.protocol.getCheckRemoteCommands({
      denops: args.denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
    });

    // Execute commands
    let updateSuccess = true;
    const logMessage: string[] = [];
    for (const command of commands) {
      const { success, code } = await this.#runCommand(
        args.denops,
        args.extParams,
        plugin,
        command,
        (msg) => logMessage.push(msg),
      );
      if (!success) {
        await this.#printError(
          args.denops,
          args.extParams,
          `Command failed with exit code ${code}: ${command.command}`,
        );
        updateSuccess = false;
        break;
      }
    }

    if (updateSuccess && logMessage.length > 0) {
      const url = await protocol.protocol.getUrl({
        denops: args.denops,
        plugin,
        protocolOptions: protocol.options,
        protocolParams: protocol.params,
      });

      const [oldRev, newRev] = await Promise.all([
        protocol.protocol.getRevision({
          denops: args.denops,
          plugin,
          protocolOptions: protocol.options,
          protocolParams: protocol.params,
        }),
        protocol.protocol.getRemoteRevision({
          denops: args.denops,
          plugin,
          protocolOptions: protocol.options,
          protocolParams: protocol.params,
        }),
      ]);

      if (newRev === oldRev) {
        // Skip
        return;
      }

      const [oldRevDate, newRevDate, histories] = await Promise.all([
        protocol.protocol.getDateFromRevision({
          denops: args.denops,
          plugin,
          protocolOptions: protocol.options,
          protocolParams: protocol.params,
          rev: oldRev,
        }),
        protocol.protocol.getDateFromRevision({
          denops: args.denops,
          plugin,
          protocolOptions: protocol.options,
          protocolParams: protocol.params,
          rev: newRev,
        }),
        protocol.protocol.getHistories({
          denops: args.denops,
          plugin,
          protocolOptions: protocol.options,
          protocolParams: protocol.params,
          start: newRev,
          end: oldRev,
        }),
      ]);

      const updated = {
        plugin,
        protocol,
        oldRev,
        newRev,
        oldRevDate,
        newRevDate,
        url,
        logMessage: logMessage.join("\n"),
        changesCount: logMessage.length,
        histories,
      };

      checkedPlugins.push(updated);

      if (plugin.hook_post_check_update) {
        await args.denops.call(
          "dpp#ext#installer#_call_hook",
          "post_check_update",
          plugin,
          {
            plugin,
            oldRev,
            newRev,
          },
        );

        const hookResult = await vars.g.get(
          args.denops,
          "dpp#hook_result",
          null,
        );
        if (hookResult) {
          // Skip
          return;
        }
      }

      if (
        await checkPluginCommits(
          args.denops,
          args.extParams,
          protocol,
          latestRollbacks,
          checkHistories,
          plugin,
          oldRev,
          newRev,
          oldRevDate,
          newRevDate,
        )
      ) {
        // Skip
        return;
      }

      updatedPlugins.push(updated);
    }
  }

  async #promptAndUpdate(
    args: {
      denops: Denops;
      context: Context;
      options: DppOptions;
      protocols: Record<ProtocolName, Protocol>;
      extOptions: ExtOptions;
      extParams: Params;
      actionParams: BaseParams;
    },
    checked: CheckUpdatedPlugin[],
    params: CheckParams,
  ) {
    const notInstalled = await this.actions.getNotInstalled.callback(args);

    if (notInstalled.length > 0) {
      await this.#printNotInstalledPlugins(
        args.denops,
        args.extParams,
        notInstalled,
      );
    }

    const map = new Map<string, CheckUpdatedPlugin>();
    for (const cp of checked) {
      map.set(cp.plugin.name, cp);
    }
    for (const p of notInstalled) {
      if (!map.has(p.name)) {
        map.set(p.name, { plugin: p });
      }
    }

    const updatedPlugins: CheckUpdatedPlugin[] = Array.from(
      map.values(),
    ).sort((a, b) => a.plugin.name.localeCompare(b.plugin.name));

    if (updatedPlugins.length === 0) {
      await this.#printMessage(
        args.denops,
        args.extParams,
        "Updated plugins are not found.",
      );

      await args.denops.cmd(
        "doautocmd User Dpp:ext:installer:updateDone",
      );

      return;
    }

    if (!params.force) {
      const check = await this.#updatedCheck(args.denops);
      if (!check) {
        await args.denops.cmd(
          "doautocmd User Dpp:ext:installer:updateDone",
        );

        return;
      }
    }

    const plugins = await getPlugins(
      args.denops,
      updatedPlugins.map((updated) => updated.plugin.name),
    );
    await this.#updatePlugins(args, plugins, {}, false);
  }

  async #getLogMessage(
    denops: Denops,
    extParams: Params,
    plugin: Plugin,
    protocol: Protocol,
    oldRev: string,
    newRev: string,
  ): Promise<string> {
    if (newRev === oldRev || newRev.length === 0 || oldRev.length === 0) {
      return "";
    }

    const commands = await protocol.protocol.getLogCommands({
      denops: denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
      newRev,
      oldRev,
    });

    const logMessage: string[] = [];
    for (const command of commands) {
      await this.#runCommand(
        denops,
        extParams,
        plugin,
        command,
        (msg) => logMessage.push(msg),
      );
    }

    return logMessage.join("\n");
  }

  async #getChangesCount(
    denops: Denops,
    extParams: Params,
    plugin: Plugin,
    protocol: Protocol,
    oldRev: string,
    newRev: string,
  ): Promise<number> {
    if (newRev === oldRev || newRev.length === 0 || oldRev.length === 0) {
      return 0;
    }

    const commands = await protocol.protocol.getChangesCountCommands({
      denops: denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
      newRev,
      oldRev,
    });

    let changesCount = 0;
    for (const command of commands) {
      await this.#runCommand(
        denops,
        extParams,
        plugin,
        command,
        (msg) => {
          changesCount = parseInt(msg, 10);
        },
      );
    }

    return changesCount;
  }

  async #buildPlugin(
    denops: Denops,
    extParams: Params,
    plugin: Plugin,
  ) {
    const build = (plugin.extAttrs as Attrs)?.installerBuild;
    if (!plugin.path || !await isDirectory(plugin.path) || !build) {
      return;
    }

    const { stdout, stderr, status } = new Deno.Command(
      await op.shell.getGlobal(denops),
      {
        args: [await op.shellcmdflag.getGlobal(denops), build],
        cwd: plugin.path,
        stdout: "piped",
        stderr: "piped",
      },
    ).spawn();

    pipeStream(stdout, this.#printProgress.bind(this, denops, extParams));
    pipeStream(stderr, this.#printError.bind(this, denops, extParams));
    await status;
  }

  async #denoCachePlugins(
    denops: Denops,
    extParams: Params,
    plugins: Plugin[],
  ) {
    if (!await fn.executable(denops, "deno")) {
      return;
    }

    // Execute "deno cache" to optimize in parallel
    const semaphore = new Semaphore(extParams.maxProcesses);
    await Promise.all(plugins.map((plugin) =>
      semaphore.lock(async () => {
        if (
          !plugin.path || !await isDirectory(`${plugin.path}/denops`) ||
          plugin.name === "denops.vim"
        ) {
          return;
        }

        const { stdout, stderr, status } = new Deno.Command(
          "deno",
          {
            args: ["cache", "--no-check", "--reload", "."],
            env: { NO_COLOR: "1" },
            stdout: "piped",
            stderr: "piped",
            // plugin.path is guaranteed non-null and is a valid directory
            // because isDirectory(`${plugin.path}/denops`) was verified above
            cwd: plugin.path!,
          },
        ).spawn();

        pipeStream(stdout, this.#printProgress.bind(this, denops, extParams));
        pipeStream(stderr, this.#printError.bind(this, denops, extParams));
        await status;
      })
    ));
  }

  async #revisionLockPlugin(
    denops: Denops,
    extParams: Params,
    plugin: Plugin,
    protocol: Protocol,
  ) {
    if (!plugin.path || !await isDirectory(plugin.path) || !plugin.rev) {
      return;
    }

    const commands = await protocol.protocol.getRevisionLockCommands({
      denops: denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
    });

    for (const command of commands) {
      await this.#runCommand(
        denops,
        extParams,
        plugin,
        command,
        this.#printProgress.bind(this, denops, extParams),
      );
    }
  }

  async #checkDiff(
    denops: Denops,
    extParams: Params,
    plugin: Plugin,
    protocol: Protocol,
    oldRev: string,
    newRev: string,
  ) {
    if (newRev === oldRev || newRev.length === 0 || oldRev.length === 0) {
      return;
    }

    const commands = await protocol.protocol.getDiffCommands({
      denops: denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
      newRev,
      oldRev,
    });

    for (const command of commands) {
      const output: string[] = [];

      await this.#runCommand(
        denops,
        extParams,
        plugin,
        command,
        (msg) => {
          if (msg) output.push(msg);
        },
      );

      const extsPattern = extParams.checkExts.join("|").replace(
        /\./g,
        "\\.",
      );
      const regex = new RegExp(
        `https?:\\/\\/[^\\s"]+\\.(${extsPattern})(\\b|\\?|#|\\")`,
        "i",
      );
      for (const line of output) {
        if (line.startsWith("+")) {
          const m = line.match(regex);
          if (m) {
            await printError(
              denops,
              `${plugin.name}: A new direct link to a .${m[1]} ` +
                "file has been added to the README.",
              "This could indicate a potential account takeover " +
                "or suspicious distribution. Please review carefully.",
            );
          }
        }
      }

      if (extParams.checkDiff) {
        await outputCheckDiff(denops, output);
      }
    }
  }

  async #printUpdatedPlugins(
    denops: Denops,
    extParams: Params,
    updatedPlugins: UpdatedPlugin[],
  ) {
    await this.#printMessage(
      denops,
      extParams,
      "Updated plugins:\n" +
        `${updatedPlugins.map((updated) => formatPlugin(updated)).join("\n")}`,
    );

    // If it has breaking changes commit message
    // https://www.conventionalcommits.org/en/v1.0.0/
    const breakingPlugins = updatedPlugins.filter(
      (updated) => updated.logMessage.match(/.*!.*:|BREAKING CHANGE:/),
    );

    if (breakingPlugins.length > 0) {
      await this.#printMessage(
        denops,
        extParams,
        "Breaking updated plugins:\n" +
          `${
            breakingPlugins.map((updated) => "  " + updated.plugin.name)
              .join("\n")
          }`,
      );
    }
  }

  async #printNotInstalledPlugins(
    denops: Denops,
    extParams: Params,
    plugins: Plugin[],
  ) {
    await this.#printMessage(
      denops,
      extParams,
      "Not installed plugins:\n" +
        `${plugins.map((plugin) => "  " + plugin.name).join("\n")}`,
    );
  }

  async #runCommand(
    denops: Denops,
    extParams: Params,
    plugin: Plugin,
    command: { command: string; args: string[] },
    onStdout: (msg: string) => unknown | Promise<unknown>,
  ): Promise<{ success: boolean; code: number }> {
    const isDir = await isDirectory(plugin.path ?? "");
    const child = new Deno.Command(
      command.command,
      {
        args: command.args,
        cwd: isDir ? plugin.path : Deno.cwd(),
        stdout: "piped",
        stderr: "piped",
      },
    ).spawn();

    // Start piping stdout/stderr concurrently and wait for both to finish.
    const stdoutStream = child.stdout!;
    const stderrStream = child.stderr!;

    const stdoutP = pipeStream(stdoutStream, onStdout).catch(async (e) => {
      await this.#printError(
        denops,
        extParams,
        `stdout pipe error for ${plugin.name}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    });
    const stderrP = pipeStream(
      stderrStream,
      this.#printError.bind(this, denops, extParams),
    ).catch(async (e) => {
      await this.#printError(
        denops,
        extParams,
        `stderr pipe error for ${plugin.name}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    });

    const status = await child.status;

    // Wait for stream pipes to finish as well (best-effort).
    await Promise.all([stdoutP, stderrP]);

    return status;
  }

  async #updatedCheck(
    denops: Denops,
  ): Promise<boolean> {
    return await fn.confirm(
      denops,
      `Update now?`,
      "yes\nNo",
      2,
    ) === 1;
  }

  async #printError(
    denops: Denops,
    protocolParams: Params,
    msg: string,
  ) {
    if (msg.includes("fatal: could not read Username for ")) {
      // NOTE: It is github's invalid repository error message.
      await printError(denops, "Target repository name is invalid.");
      await printError(denops, "You may have used the wrong plugin name.");
    }

    await printError(denops, msg);
    this.#updateLogs.push(msg);
    this.#logs.push(msg);

    this.#outputLogFile(denops, protocolParams, msg);
  }

  async #printMessage(
    denops: Denops,
    protocolParams: Params,
    msg: string,
  ) {
    await denops.call("dpp#ext#installer#_print_message", msg);
    this.#updateLogs.push(msg);
    this.#logs.push(msg);

    this.#outputLogFile(denops, protocolParams, msg);
  }

  async #printProgress(
    denops: Denops,
    protocolParams: Params,
    msg: string,
  ) {
    await denops.call("dpp#ext#installer#_print_progress_message", msg);
    this.#logs.push(msg);

    this.#outputLogFile(denops, protocolParams, msg);
  }

  async #outputLogFile(
    denops: Denops,
    protocolParams: Params,
    msg: string,
  ) {
    if (protocolParams.logFilePath.length === 0) {
      return;
    }

    if (this.#cachedLogFilePathParam !== protocolParams.logFilePath) {
      this.#cachedLogFilePath = await denops.call(
        "dpp#util#_expand",
        protocolParams.logFilePath,
      ) as string;
      this.#cachedLogFilePathParam = protocolParams.logFilePath;
    }

    if (!this.#cachedLogFilePath) {
      return;
    }

    // Buffer the message and schedule a flush to reduce frequent small writes.
    this.#logBuffer.push(`${msg}\n`);
    if (this.#logFlushTimer === null) {
      this.#logFlushTimer = setTimeout(async () => {
        this.#logFlushTimer = null;
        // If a flush is already in progress, reschedule so buffered messages
        // are not silently dropped.
        if (this.#logFlushing) {
          this.#logFlushTimer = setTimeout(
            () => this.#scheduleFlush(),
            this.#logFlushIntervalMs,
          ) as unknown as number;
          return;
        }
        await this.#scheduleFlush();
      }, this.#logFlushIntervalMs) as unknown as number;
    }
  }

  async #scheduleFlush() {
    if (this.#logFlushing || !this.#cachedLogFilePath) return;
    this.#logFlushing = true;
    const content = this.#logBuffer.join("");
    this.#logBuffer = [];
    try {
      await Deno.writeTextFile(this.#cachedLogFilePath, content, {
        append: true,
      });
    } catch (e) {
      console.error(
        `[dpp-ext-installer] Failed to flush log buffer: ${e}`,
      );
    } finally {
      this.#logFlushing = false;
    }
  }
}

async function getPlugins(
  denops: Denops,
  names: string[],
): Promise<Plugin[]> {
  // NOTE: Skip local plugins
  let plugins = await denops.call("dpp#util#_get_plugins") as Plugin[];

  if (names.length > 0) {
    const namesSet = new Set(names);
    plugins = plugins.filter((plugin) => namesSet.has(plugin.name));
  }

  return plugins;
}

async function outputCheckDiff(denops: Denops, output: string[]) {
  if (output.length === 0) {
    return;
  }

  const bufname = "dpp-diff";
  const bufnr = await fn.bufexists(denops, bufname)
    ? await fn.bufnr(denops, bufname)
    : await fn.bufadd(denops, bufname);

  if (
    await fn.bufwinnr(denops, bufnr) < 0 && await fn.bufexists(denops, bufnr)
  ) {
    const winId = await fn.win_getid(denops);

    const cmd =
      "setlocal bufhidden=wipe filetype=diff buftype=nofile nolist | syntax enable"
        .replaceAll(" ", "\\ ");
    await denops.cmd(`sbuffer +${cmd} ${bufnr}`);

    // Restore the cursor
    await fn.win_gotoid(denops, winId);
  }

  await batch(denops, async (denops: Denops) => {
    await fn.setbufvar(denops, bufnr, "&modifiable", true);
    const CHUNK = 500;
    for (let i = 0; i < output.length; i += CHUNK) {
      const chunk = output.slice(i, i + CHUNK);
      await fn.appendbufline(denops, bufnr, "$", chunk);
    }
    await fn.setbufvar(denops, bufnr, "&modifiable", false);
  });
}

async function saveRollbackFile(
  denops: Denops,
  protocols: Record<ProtocolName, Protocol>,
  updatedPlugins: UpdatedPlugin[],
) {
  // Get revisions with limited concurrency to avoid excessive IO/processes
  const plugins = await getPlugins(denops, []);
  const rollbacks: Rollbacks = {};
  const sem = new Semaphore(5);
  await Promise.all(
    plugins.map((plugin) =>
      sem.lock(async () => {
        const protocolName = plugin.protocol ?? "";
        if (protocolName.length === 0) return;
        const protocol = protocols[protocolName];
        const newRev = await protocol.protocol.getRevision({
          denops: denops,
          plugin,
          protocolOptions: protocol.options,
          protocolParams: protocol.params,
        });
        const newRevDate = await protocol.protocol.getDateFromRevision({
          denops: denops,
          plugin,
          protocolOptions: protocol.options,
          protocolParams: protocol.params,
          rev: newRev,
        });
        rollbacks[plugin.name] = {
          name: plugin.name,
          newRev,
          newRevDate,
        };
      })
    ),
  );

  // Overwrite rollbacks by updated plugins information
  const updateDate = new Date();
  for (const updated of updatedPlugins) {
    rollbacks[updated.plugin.name] = {
      name: updated.plugin.name,
      updateDate,
      newRev: updated.newRev,
      oldRev: updated.oldRev,
      newRevDate: updated.newRevDate,
      oldRevDate: updated.oldRevDate,
    };
  }

  // Save rollback file
  const basePath = await denops.call("dpp#util#_get_base_path");
  const name = await denops.call("dpp#util#_get_name");
  for (const date of ["latest", getFormattedDate(new Date())]) {
    const dir = `${basePath}/${name}/rollbacks/${date}`;
    await Deno.mkdir(dir, { recursive: true });
    const file = `${dir}/rollback.json`;
    await Deno.writeTextFile(file, JSON.stringify(rollbacks));
  }
}

async function loadRollbacks(
  denops: Denops,
  date: string,
): Promise<Rollbacks> {
  const basePath = await denops.call("dpp#util#_get_base_path");
  const name = await denops.call("dpp#util#_get_name");
  const dir = `${basePath}/${name}/rollbacks/${date}`;
  const file = `${dir}/rollback.json`;
  if (!await safeStat(file)) {
    return {};
  }

  try {
    return JSON.parse(await Deno.readTextFile(file), (key, value) => {
      if (key.endsWith("Date") && typeof value === "string") {
        return new Date(value);
      }
      return value;
    }) as Rollbacks;
  } catch (e) {
    await printError(
      denops,
      `Failed to parse rollback file: ${file}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return {};
  }
}

async function saveCheckHistories(
  denops: Denops,
  checkedPlugins: CheckedPlugin[],
) {
  const checkHistories: CheckHistories = {};
  const checkDate = new Date();
  for (const checked of checkedPlugins) {
    checkHistories[checked.plugin.name] = {
      name: checked.plugin.name,
      checkDate,
      newRev: checked.newRev,
      oldRev: checked.oldRev,
      newRevDate: checked.newRevDate,
      oldRevDate: checked.oldRevDate,
      histories: checked.histories, // TODO
    };
  }

  // Save "check_history.json" file
  const basePath = await denops.call("dpp#util#_get_base_path");
  const name = await denops.call("dpp#util#_get_name");
  const dir = `${basePath}/${name}`;
  await Deno.mkdir(dir, { recursive: true });
  const file = `${dir}/check_history.json`;
  await Deno.writeTextFile(file, JSON.stringify(checkHistories));
}

async function loadCheckHistories(
  denops: Denops,
): Promise<CheckHistories> {
  const basePath = await denops.call("dpp#util#_get_base_path");
  const name = await denops.call("dpp#util#_get_name");
  const dir = `${basePath}/${name}`;
  const file = `${dir}/check_history.json`;
  if (!await safeStat(file)) {
    return {};
  }

  try {
    return JSON.parse(await Deno.readTextFile(file), (key, value) => {
      if (key.endsWith("Date") && typeof value === "string") {
        return new Date(value);
      }
      return value;
    }) as CheckHistories;
  } catch (e) {
    await printError(
      denops,
      `Failed to parse rollback file: ${file}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return {};
  }
}

function formatPlugin(updated: UpdatedPlugin): string {
  const isSupportedHost = /^https?:\/\/(github\.com|codeberg\.org)\//.test(
    updated.url,
  );

  const compareLink = updated.oldRev !== "" && isSupportedHost
    ? `\n    ${
      updated.url.replace(/\.git$/, "").replace(/^\w+:/, "https:")
    }/compare/${updated.oldRev}...${updated.newRev}`
    : "";
  const changes = updated.changesCount === 0
    ? ""
    : `(${updated.changesCount} change${
      updated.changesCount === 1 ? "" : "s"
    })`;
  const pad = (n: number) => n.toString().padStart(2, "0");
  const formatDate = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${
      pad(d.getHours())
    }:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const oldDate = updated.oldRevDate
    ? `${formatDate(updated.oldRevDate)}`
    : "-";
  const newDate = updated.newRevDate
    ? `${formatDate(updated.newRevDate)}`
    : "-";
  const ago = updated.newRevDate ? ` (${timeAgo(updated.newRevDate)})` : "";
  const date = updated.oldRevDate || updated.newRevDate
    ? `\n    ${oldDate} -> ${newDate}${ago}`
    : "";
  return `  ${updated.plugin.name}${changes}${compareLink}${date}`;
}

async function checkPluginCommits(
  denops: Denops,
  extParams: Params,
  protocol: Protocol,
  latestRollbacks: Rollbacks,
  checkHistories: CheckHistories,
  plugin: Plugin,
  oldRev: string,
  newRev: string,
  oldRevDate: Date | null,
  newRevDate: Date | null,
): Promise<boolean> {
  if (!oldRevDate || !newRevDate) {
    return false;
  }

  const pad = (n: number) => n.toString().padStart(2, "0");
  const formatDate = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${
      pad(d.getHours())
    }:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const minDays = (plugin.extAttrs as Attrs)?.installerMinCommitDays ??
    extParams.minCommitDays;
  const maxDays = (plugin.extAttrs as Attrs)?.installerMaxInactiveDays ??
    extParams.maxInactiveDays;
  const current = new Date();
  const diff = dateDiffDays(current, newRevDate);
  if (diff !== null) {
    if (diff < minDays) {
      await printError(
        denops,
        `${plugin.name}: update is invalid!`,
        `  Current day:     ${formatDate(current)}`,
        `  Current commit:  ${formatDate(oldRevDate)}`,
        `  New commit:      ${formatDate(newRevDate)}`,
        `  Days since last commit: ${diff} (minimum required: ${minDays})`,
      );
      return true;
    }

    if (diff > maxDays) {
      await printError(
        denops,
        `${plugin.name}: inactive update is detected!`,
        `  Current day:     ${formatDate(current)}`,
        `  Current commit:  ${formatDate(oldRevDate)}`,
        `  New commit:      ${formatDate(newRevDate)}`,
        `  Days since last commit: ${diff}`,
        "This plugin had no updates for a long period before this.",
        "You should check the commit.",
      );
    }
  }

  const rollback = latestRollbacks[plugin.name];
  if (rollback?.updateDate && rollback.updateDate > newRevDate) {
    await printError(
      denops,
      `${plugin.name}: older commit is detected!`,
      `  The last update: ${formatDate(rollback.updateDate)}`,
      `  Current commit:  ${formatDate(oldRevDate)}`,
      `  New commit:      ${formatDate(newRevDate)}`,
      "You should check the commit.",
    );
  }

  const checkHistory = checkHistories[plugin.name];
  if (checkHistory?.newRevDate && checkHistory.newRevDate > newRevDate) {
    await printError(
      denops,
      `${plugin.name}: older commit is detected!`,
      `  The last check: ${formatDate(checkHistory.checkDate)}`,
      `  Current commit: ${formatDate(oldRevDate)}`,
      `  Checked commit: ${formatDate(checkHistory.newRevDate)}`,
      `  New commit:     ${formatDate(newRevDate)}`,
      "You should check the commit.",
    );
  }

  const prevHistories = new Set(checkHistory?.histories ?? []);
  if (prevHistories.size > 0) {
    const histories = await protocol.protocol.getHistories({
      denops: denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
      start: newRev,
      end: oldRev,
    });
    const newHistories = histories.filter((history) =>
      !prevHistories.has(history)
    );
    const checkDate = rollback?.updateDate ?? checkHistory?.checkDate ??
      new Date(0);
    for (const history of newHistories) {
      const commitDate = await protocol.protocol.getDateFromRevision({
        denops: denops,
        plugin,
        protocolOptions: protocol.options,
        protocolParams: protocol.params,
        rev: history,
      });
      if (commitDate && commitDate < checkDate) {
        const lastUpdate = (rollback?.updateDate || checkHistory?.checkDate)
          ? formatDate(rollback?.updateDate || checkHistory?.checkDate!)
          : "unknown";
        await printError(
          denops,
          `${plugin.name}: suspicious old commit is detected in history!`,
          `  Commit: ${history}`,
          `  Commit date: ${formatDate(commitDate)}`,
          `  Last update/check: ${lastUpdate}`,
          "You should check the commit.",
        );
      }
    }
  }

  return false;
}

type InstalledFileMatch = {
  url: string;
  index: number;
  line: number;
  column: number;
};

async function checkInstalledFiles(
  extParams: Params,
  plugin: Plugin,
): Promise<InstalledFileMatch[]> {
  if (!plugin.path) {
    return [];
  }

  const readmePaths = [
    `${plugin.path}/README`,
    `${plugin.path}/README.md`,
    `${plugin.path}/README.rst`,
    `${plugin.path}/README.txt`,
  ];

  let readmePath = "";
  for (const path of readmePaths) {
    const stat = await safeStat(path);
    if (stat?.isFile) {
      readmePath = path;
      break;
    }
  }

  if (readmePath.length === 0) {
    return [];
  }

  const content = await Deno.readTextFile(readmePath);

  const checkExts = (
    extParams as { checkExts?: string[] }
  ).checkExts?.filter((val) => val.length > 0) ?? [];

  if (checkExts.length === 0) {
    return [];
  }

  const extsPattern = checkExts
    .map((ext) => ext.replace(/^\./, "").replace(/\./g, "\\."))
    .join("|");

  const regex = new RegExp(
    `https?:\\/\\/[^\\s"]+\\.(${extsPattern})(\\b|\\?|#|")`,
    "gi",
  );

  const matches: InstalledFileMatch[] = [];

  for (const match of content.matchAll(regex)) {
    if (match.index === undefined) continue;

    const index = match.index;
    const before = content.slice(0, index);
    const line = before.split("\n").length;
    const column = before.length - before.lastIndexOf("\n");

    matches.push({
      url: match[0],
      index,
      line,
      column,
    });
  }

  return matches;
}
