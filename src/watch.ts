import * as tstl from "typescript-to-lua";
import * as diagnosticFactories from "typescript-to-lua/dist/diagnostics";
import * as ts from "typescript";
import * as path from "path";
import * as rimraf from "rimraf";
import { spawn } from "child_process";
import { setupTemporaryDirectory, findAndParseConfigFile } from "./start";

export const luaConfHead = `
package.path = package.path .. ";node_modules/?/init.lua"
package.path = package.path .. ";node_modules/?/?.lua"
`;

const luaMainTail = `
local oldUpdate = love.update
function love.update(delta)
    if oldUpdate then
        oldUpdate(delta)
    end
    require("lurker").update()
end
`;

export function transpileExecuteAndWatch(configPath: string): void {
    const outDir = setupTemporaryDirectory();
    const [configFilePath, parsedConfigFile] = findAndParseConfigFile(configPath);
    parsedConfigFile.options.outDir = outDir;
    parsedConfigFile.options.project = configPath;
    parsedConfigFile.options.sourceMapTraceback = true;

    createWatchOfConfigFile(configFilePath, parsedConfigFile.options);
}

let lumeContent: string;
let lurkerContent: string;

function emitFiles(outputFiles: tstl.OutputFile[], { outDir }: tstl.CompilerOptions): void {
    let wroteConf = false;
    outputFiles.forEach(({ name, text }) => {
        switch (path.basename(name)) {
            case "conf.lua": {
                ts.sys.writeFile(name, `${luaConfHead}\n${text}`);
                wroteConf = true;
                break;
            }
            case "main.lua": {
                ts.sys.writeFile(name, `${text}\n${luaMainTail}`);
                break;
            }
            default: {
                ts.sys.writeFile(name, text);
                break;
            }
        }
    });

    if (!wroteConf) {
        ts.sys.writeFile(path.join(outDir, "conf.lua"), luaConfHead);
    }

    if (!lumeContent && !lurkerContent) {
        const lumePath = path.resolve(path.join(__dirname, "../lib/lume.lua"));
        const lurkerPath = path.resolve(path.join(__dirname, "../lib/lurker.lua"));
        lumeContent = ts.sys.readFile(lumePath, "utf8");
        lurkerContent = ts.sys.readFile(lurkerPath, "utf8");
        ts.sys.writeFile(path.join(outDir, "lume.lua"), lumeContent);
        ts.sys.writeFile(path.join(outDir, "lurker.lua"), lurkerContent);
    }
}

function createWatchStatusReporter(options?: ts.CompilerOptions): ts.WatchStatusReporter {
    return (ts as any).createWatchStatusReporter(ts.sys, shouldBePretty(options));
}

let reportDiagnostic = tstl.createDiagnosticReporter(false);
function updateReportDiagnostic(options?: ts.CompilerOptions): void {
    reportDiagnostic = tstl.createDiagnosticReporter(shouldBePretty(options));
}

function shouldBePretty(options?: ts.CompilerOptions): boolean {
    return !options || options.pretty === undefined
        ? ts.sys.writeOutputIsTTY !== undefined && ts.sys.writeOutputIsTTY()
        : Boolean(options.pretty);
}

function createWatchOfConfigFile(configFileName: string, optionsToExtend: tstl.CompilerOptions): void {
    const watchCompilerHost = ts.createWatchCompilerHost(
        configFileName,
        optionsToExtend,
        ts.sys,
        ts.createSemanticDiagnosticsBuilderProgram,
        undefined,
        createWatchStatusReporter(optionsToExtend)
    );

    updateWatchCompilationHost(watchCompilerHost, optionsToExtend);
    ts.createWatchProgram(watchCompilerHost);
}

function updateWatchCompilationHost(
    host: ts.WatchCompilerHost<ts.SemanticDiagnosticsBuilderProgram>,
    optionsToExtend: tstl.CompilerOptions
): void {
    let fullRecompile = true;
    const configFileMap = new WeakMap<ts.TsConfigSourceFile, ts.ParsedCommandLine>();

    let loveIsRunning = false;

    host.afterProgramCreate = builderProgram => {
        const program = builderProgram.getProgram();
        const options = builderProgram.getCompilerOptions() as tstl.CompilerOptions;

        let configFileParsingDiagnostics: ts.Diagnostic[] = [];
        const configFile = options.configFile as ts.TsConfigSourceFile | undefined;
        const configFilePath = options.configFilePath as string | undefined;
        if (configFile && configFilePath) {
            if (!configFileMap.has(configFile)) {
                const parsedConfigFile = tstl.updateParsedConfigFile(
                    ts.parseJsonSourceFileConfigFileContent(
                        configFile,
                        ts.sys,
                        path.dirname(configFilePath),
                        optionsToExtend,
                        configFilePath
                    )
                );

                configFileMap.set(configFile, parsedConfigFile);
            }

            const parsedConfigFile = configFileMap.get(configFile)!;
            Object.assign(options, parsedConfigFile.options);
            configFileParsingDiagnostics = parsedConfigFile.errors;
        }

        let sourceFiles: ts.SourceFile[] | undefined;
        if (!fullRecompile) {
            sourceFiles = [];
            while (true) {
                const currentFile = builderProgram.getSemanticDiagnosticsOfNextAffectedFile();
                if (!currentFile) break;

                if ("fileName" in currentFile.affected) {
                    sourceFiles.push(currentFile.affected);
                } else {
                    sourceFiles.push(...currentFile.affected.getSourceFiles());
                }
            }
        }

        const { diagnostics: emitDiagnostics, transpiledFiles } = tstl.transpile({ program, sourceFiles });

        const emitResult = tstl.emitTranspiledFiles(options, transpiledFiles);
        emitFiles(emitResult, options);

        const diagnostics = ts.sortAndDeduplicateDiagnostics([
            ...configFileParsingDiagnostics,
            ...program.getOptionsDiagnostics(),
            ...program.getSyntacticDiagnostics(),
            ...program.getGlobalDiagnostics(),
            ...program.getSemanticDiagnostics(),
            ...emitDiagnostics,
        ]);

        diagnostics.forEach(reportDiagnostic);

        const errors = diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error);
        // do a full recompile after an error
        fullRecompile = errors.length > 0;

        host.onWatchStatusChange!(diagnosticFactories.watchErrorSummary(errors.length), host.getNewLine(), options);

        if (!loveIsRunning) {
            const { outDir } = optionsToExtend;
            const child = spawn("lovec", [outDir], { stdio: [process.stdin, process.stdout, process.stderr] });
            child.on("close", function () {
                ts.sys.exit(0);
                rimraf(outDir, {}, () => {});
            });
            loveIsRunning = true;
        }
    };
}
