import {
  Actions,
  BaseExt,
  DppOptions,
  Plugin,
  Protocol,
  ProtocolName,
} from "https://deno.land/x/dpp_vim@v0.0.3/types.ts";
import { Denops, op, vars } from "https://deno.land/x/dpp_vim@v0.0.3/deps.ts";
import { isDirectory } from "https://deno.land/x/dpp_vim@v0.0.3/utils.ts";

type Params = Record<string, never>;

type InstallParams = {
  names: string[];
};

export class Ext extends BaseExt<Params> {
  override actions: Actions<Params> = {
    build: {
      description: "Build plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: unknown;
      }) => {
        const params = args.actionParams as InstallParams;

        const plugins = await getPlugins(args.denops, params.names ?? []);

        for (const plugin of plugins) {
          await buildPlugin(args.denops, plugin);
        }
      },
    },
    install: {
      description: "Install plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: unknown;
      }) => {
        const params = args.actionParams as InstallParams;
        const plugins = await getPlugins(args.denops, params.names ?? []);

        const bits = await Promise.all(
          plugins.map(async (plugin) =>
            plugin.path && !await isDirectory(plugin.path)
          ),
        );

        await updatePlugins(args, plugins.filter((_) => bits.shift()));
      },
    },
    update: {
      description: "Update plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: unknown;
      }) => {
        const params = args.actionParams as InstallParams;
        await updatePlugins(
          args,
          await getPlugins(args.denops, params.names ?? []),
        );
      },
    },
    reinstall: {
      description: "Reinstall plugins",
      callback: async (args: {
        denops: Denops;
        options: DppOptions;
        protocols: Record<ProtocolName, Protocol>;
        actionParams: unknown;
      }) => {
        const params = args.actionParams as InstallParams;
        if (!params.names || params.names.length === 0) {
          // NOTE: names must be set.
          await args.denops.call(
            "dpp#util#_error",
            "names must be set for reinstall plugins.",
          );
          return;
        }

        const plugins = await getPlugins(args.denops, params.names ?? []);

        for (const plugin of plugins) {
          // Remove plugin directory
          if (plugin.path && await isDirectory(plugin.path)) {
            await Deno.remove(plugin.path, { recursive: true });
          }
        }

        await updatePlugins(args, plugins);
      },
    },
  };

  override params(): Params {
    return {};
  }
}

async function updatePlugins(args: {
  denops: Denops;
  options: DppOptions;
  protocols: Record<ProtocolName, Protocol>;
  actionParams: unknown;
}, plugins: Plugin[]) {
  if (plugins.length === 0) {
    await args.denops.call(
      "dpp#util#_error",
      "Target plugins are not found.",
    );
    await args.denops.call(
      "dpp#util#_error",
      "You may have used the wrong plugin name," +
        " or all of the plugins are already installed.",
    );
    return;
  }

  let count = 1;
  for (const plugin of plugins) {
    await args.denops.call(
      "dpp#ext#installer#_print_progress_message",
      `[${count}/${plugins.length}] ${plugin.name}`,
    );

    const protocol = args.protocols[plugin.protocol ?? ""];

    const commands = await protocol.protocol.getSyncCommands({
      denops: args.denops,
      plugin,
      protocolOptions: protocol.options,
      protocolParams: protocol.params,
    });

    // Execute commands
    for (const command of commands) {
      const proc = new Deno.Command(
        command.command,
        {
          args: command.args,
          cwd: await isDirectory(plugin.path ?? "") ? plugin.path : Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        },
      );

      const { stdout, stderr, success } = await proc.output();

      for (
        const line of new TextDecoder().decode(stdout).split(/\r?\n/).filter((
          line,
        ) => line.length > 0)
      ) {
        await args.denops.call(
          "dpp#ext#installer#_print_progress_message",
          line,
        );
      }

      for (
        const line of new TextDecoder().decode(stderr).split(/\r?\n/).filter((
          line,
        ) => line.length > 0)
      ) {
        await args.denops.call(
          "dpp#ext#installer#_print_progress_message",
          line,
        );
      }

      if (success) {
        await buildPlugin(args.denops, plugin);
      }
    }

    count += 1;
  }

  await args.denops.call("dpp#ext#installer#_close_progress_window");

  await args.denops.call("dpp#clear_state");
}

async function getPlugins(
  denops: Denops,
  names: string[],
): Promise<Plugin[]> {
  // NOTE: Skip local plugins
  let plugins = (Object.values(
    await vars.g.get(
      denops,
      "dpp#_plugins",
    ),
  ) as Plugin[]).filter((plugin) => !plugin.local);

  if (names.length > 0) {
    plugins = plugins.filter((plugin) => names.indexOf(plugin.name) >= 0);
  }

  return plugins;
}

async function buildPlugin(
  denops: Denops,
  plugin: Plugin,
) {
  if (!plugin.path || !await isDirectory(plugin.path) || !plugin.build) {
    return;
  }

  const proc = new Deno.Command(
    await op.shell.getGlobal(denops),
    {
      args: [await op.shellcmdflag.getGlobal(denops), plugin.build],
      cwd: plugin.path,
      stdout: "piped",
      stderr: "piped",
    },
  );

  const { stdout, stderr } = await proc.output();

  for (
    const line of new TextDecoder().decode(stdout).split(/\r?\n/).filter((
      line,
    ) => line.length > 0)
  ) {
    await denops.call(
      "dpp#ext#installer#_print_progress_message",
      line,
    );
  }

  for (
    const line of new TextDecoder().decode(stderr).split(/\r?\n/).filter((
      line,
    ) => line.length > 0)
  ) {
    await denops.call(
      "dpp#ext#installer#_print_progress_message",
      line,
    );
  }
}
