import luau, { renderAST } from "@roblox-ts/luau-ast";
import { PathTranslator } from "@roblox-ts/path-translator";
import { NetworkType, RbxPath, RojoResolver } from "@roblox-ts/rojo-resolver";
import { createHash } from "crypto";
import fs from "fs-extra";
import path from "path";
import { WorkerPool } from "Project/classes/WorkerPool";
import { checkFileName } from "Project/functions/checkFileName";
import { checkRojoConfig } from "Project/functions/checkRojoConfig";
import { createNodeModulesPathMapping } from "Project/functions/createNodeModulesPathMapping";
import transformPathsTransformer from "Project/transformers/builtin/transformPaths";
import { transformTypeReferenceDirectives } from "Project/transformers/builtin/transformTypeReferenceDirectives";
import { createTransformerList, flattenIntoTransformers } from "Project/transformers/createTransformerList";
import { createTransformerWatcher } from "Project/transformers/createTransformerWatcher";
import { getPluginConfigs } from "Project/transformers/getPluginConfigs";
import { getCustomPreEmitDiagnostics } from "Project/util/getCustomPreEmitDiagnostics";
import { LogService } from "Shared/classes/LogService";
import { ProjectType } from "Shared/constants";
import { ProjectData } from "Shared/types";
import { assert } from "Shared/util/assert";
import { benchmarkIfVerbose } from "Shared/util/benchmark";
import { createTextDiagnostic } from "Shared/util/createTextDiagnostic";
import { getRootDirs } from "Shared/util/getRootDirs";
import { MultiTransformState, transformSourceFile, TransformState } from "TSTransformer";
import { DiagnosticService } from "TSTransformer/classes/DiagnosticService";
import { createTransformServices } from "TSTransformer/util/createTransformServices";
import ts from "typescript";

// Cache for RojoResolver instances to avoid re-parsing config files
interface RojoResolverCacheEntry {
	resolver: RojoResolver;
	mtime: number;
}

const rojoResolverCache = new Map<string, RojoResolverCacheEntry>();
const syntheticResolverCache = new Map<string, RojoResolver>();

// Cache for file content hashes to avoid re-reading files for comparison
const fileHashCache = new Map<string, string>();

// Cache for nodeModulesPathMapping to avoid re-walking node_modules
const nodeModulesPathMappingCache = new Map<string, Map<string, string>>();

// Cache for incremental AST transformation - maps file path + source hash to rendered output
interface ASTCacheEntry {
	sourceHash: string;
	output: string;
	dependencies: Set<string>; // Files that this file imports
}
const astCache = new Map<string, ASTCacheEntry>();

function getOrCreateWorkerPool(data: ProjectData): WorkerPool {
	if (!data.workerPool) {
		data.workerPool = new WorkerPool(data.projectOptions.renderWorkers);
	}
	return data.workerPool;
}

function getCachedRojoResolver(configPath: string): RojoResolver {
	try {
		const currentMtime = fs.statSync(configPath).mtimeMs;
		const cached = rojoResolverCache.get(configPath);

		if (cached && cached.mtime === currentMtime) {
			return cached.resolver;
		}

		const resolver = RojoResolver.fromPath(configPath);
		rojoResolverCache.set(configPath, { resolver, mtime: currentMtime });
		return resolver;
	} catch {
		// If stat fails, create fresh resolver
		return RojoResolver.fromPath(configPath);
	}
}

function getCachedSyntheticResolver(outDir: string): RojoResolver {
	let resolver = syntheticResolverCache.get(outDir);
	if (!resolver) {
		resolver = RojoResolver.synthetic(outDir);
		syntheticResolverCache.set(outDir, resolver);
	}
	return resolver;
}

function inferProjectType(data: ProjectData, rojoResolver: RojoResolver): ProjectType {
	if (data.isPackage) {
		return ProjectType.Package;
	} else if (rojoResolver.isGame) {
		return ProjectType.Game;
	} else {
		return ProjectType.Model;
	}
}

function emitResultFailure(messageText: string): ts.EmitResult {
	return {
		emitSkipped: true,
		diagnostics: [createTextDiagnostic(messageText)],
	};
}

/**
 * 'transpiles' TypeScript project into a logically identical Luau project.
 *
 * writes rendered Luau source to the out directory.
 */
export async function compileFiles(
	program: ts.Program,
	data: ProjectData,
	pathTranslator: PathTranslator,
	sourceFiles: Array<ts.SourceFile>,
): Promise<ts.EmitResult> {
	const compilerOptions = program.getCompilerOptions();

	const multiTransformState = new MultiTransformState();

	const outDir = compilerOptions.outDir!;

	const rojoResolver = data.rojoConfigPath
		? getCachedRojoResolver(data.rojoConfigPath)
		: getCachedSyntheticResolver(outDir);

	for (const warning of rojoResolver.getWarnings()) {
		LogService.warn(warning);
	}

	checkRojoConfig(data, rojoResolver, getRootDirs(compilerOptions), pathTranslator);

	for (const sourceFile of program.getSourceFiles()) {
		if (!path.normalize(sourceFile.fileName).startsWith(data.nodeModulesPath)) {
			checkFileName(sourceFile.fileName);
		}
	}

	const pkgRojoResolvers = compilerOptions.typeRoots!.map(getCachedSyntheticResolver);

	// Cache nodeModulesPathMapping based on typeRoots to avoid re-walking directories
	const typeRootsCacheKey = compilerOptions.typeRoots!.join("|");
	let nodeModulesPathMapping = nodeModulesPathMappingCache.get(typeRootsCacheKey);
	if (!nodeModulesPathMapping) {
		nodeModulesPathMapping = createNodeModulesPathMapping(compilerOptions.typeRoots!);
		nodeModulesPathMappingCache.set(typeRootsCacheKey, nodeModulesPathMapping);
	}

	const projectType = data.projectOptions.type ?? inferProjectType(data, rojoResolver);

	if (projectType !== ProjectType.Package && data.rojoConfigPath === undefined) {
		return emitResultFailure("Non-package projects must have a Rojo project file!");
	}

	let runtimeLibRbxPath: RbxPath | undefined;
	if (projectType !== ProjectType.Package) {
		runtimeLibRbxPath = rojoResolver.getRbxPathFromFilePath(
			path.join(data.projectOptions.includePath, "RuntimeLib.lua"),
		);
		if (!runtimeLibRbxPath) {
			return emitResultFailure("Rojo project contained no data for include folder!");
		} else if (rojoResolver.getNetworkType(runtimeLibRbxPath) !== NetworkType.Unknown) {
			return emitResultFailure("Runtime library cannot be in a server-only or client-only container!");
		} else if (rojoResolver.isIsolated(runtimeLibRbxPath)) {
			return emitResultFailure("Runtime library cannot be in an isolated container!");
		}
	}

	if (DiagnosticService.hasErrors()) return { emitSkipped: true, diagnostics: DiagnosticService.flush() };

	LogService.writeLineIfVerbose(`compiling as ${projectType}..`);

	const fileWriteQueue = new Array<{ sourceFile: ts.SourceFile; source: string }>();
	const renderJobs = new Array<{ id: number; sourceFile: ts.SourceFile; luauAST: luau.List<luau.Statement> }>();
	const progressMaxLength = `${sourceFiles.length}/${sourceFiles.length}`.length;

	let proxyProgram = program;

	if (compilerOptions.plugins && compilerOptions.plugins.length > 0) {
		benchmarkIfVerbose(`running transformers..`, () => {
			const pluginConfigs = getPluginConfigs(data.tsConfigPath);
			const transformerList = createTransformerList(program, pluginConfigs, data.projectPath);
			const transformers = flattenIntoTransformers(transformerList);
			if (transformers.length > 0) {
				const { service, updateFile } = (data.transformerWatcher ??= createTransformerWatcher(program));
				const transformResult = ts.transformNodes(
					undefined,
					undefined,
					ts.factory,
					compilerOptions,
					sourceFiles,
					transformers,
					false,
				);

				if (transformResult.diagnostics) DiagnosticService.addDiagnostics(transformResult.diagnostics);

				for (const sourceFile of transformResult.transformed) {
					if (ts.isSourceFile(sourceFile)) {
						// transformed nodes don't have symbol or type information (or they have out of date information)
						// there's no way to "rebind" an existing file, so we have to reprint it
						const source = ts.createPrinter().printFile(sourceFile);
						updateFile(sourceFile.fileName, source);
						if (data.projectOptions.writeTransformedFiles) {
							const outPath = pathTranslator.getOutputTransformedPath(sourceFile.fileName);
							fs.outputFileSync(outPath, source);
						}
					}
				}

				proxyProgram = service.getProgram()!;
			}
		});
	}

	if (DiagnosticService.hasErrors()) return { emitSkipped: true, diagnostics: DiagnosticService.flush() };

	const typeChecker = proxyProgram.getTypeChecker();
	const services = createTransformServices(typeChecker);

	// Track files modified in this compilation for cache invalidation
	const modifiedFiles = new Set<string>();

	for (let i = 0; i < sourceFiles.length; i++) {
		const sourceFile = proxyProgram.getSourceFile(sourceFiles[i].fileName);
		assert(sourceFile);
		const progress = `${i + 1}/${sourceFiles.length}`.padStart(progressMaxLength);
		benchmarkIfVerbose(`${progress} compile ${path.relative(process.cwd(), sourceFile.fileName)}`, () => {
			DiagnosticService.addDiagnostics(ts.getPreEmitDiagnostics(proxyProgram, sourceFile));
			DiagnosticService.addDiagnostics(getCustomPreEmitDiagnostics(data, sourceFile));
			if (DiagnosticService.hasErrors()) return;

			// Incremental AST caching: check if we can reuse cached transformation
			const sourceText = sourceFile.getFullText();
			const sourceHash = createHash("sha256").update(sourceText).digest("hex");
			const cachedEntry = astCache.get(sourceFile.fileName);

			// Check if cache is valid: same hash and no modified dependencies
			const canUseCache =
				cachedEntry &&
				cachedEntry.sourceHash === sourceHash &&
				!Array.from(cachedEntry.dependencies).some(dep => modifiedFiles.has(dep));

			let source: string | undefined;

			if (canUseCache) {
				// Use cached output
				source = cachedEntry.output;
			} else {
				// Transform and cache
				const transformState = new TransformState(
					proxyProgram,
					data,
					services,
					pathTranslator,
					multiTransformState,
					compilerOptions,
					rojoResolver,
					pkgRojoResolvers,
					nodeModulesPathMapping,
					runtimeLibRbxPath,
					typeChecker,
					projectType,
					sourceFile,
				);

				const luauAST = transformSourceFile(transformState, sourceFile);
				if (DiagnosticService.hasErrors()) return;

				// Check if we should use parallel rendering
				const shouldUseParallelRender = data.projectOptions.parallelRender && sourceFiles.length >= 10;

				if (shouldUseParallelRender) {
					// Queue for parallel rendering
					renderJobs.push({ id: i, sourceFile, luauAST });
					// Will render in batch after transformation loop
				} else {
					// Fallback to sync rendering
					source = renderAST(luauAST);
				}

				// Track dependencies (imported files)
				const dependencies = new Set<string>();
				const resolvedModules = (sourceFile as any).resolvedModules as
					| Map<string, ts.ResolvedModuleFull | undefined>
					| undefined;
				if (resolvedModules) {
					resolvedModules.forEach((resolved: ts.ResolvedModuleFull | undefined) => {
						if (resolved?.resolvedFileName) {
							dependencies.add(resolved.resolvedFileName);
						}
					});
				}

				// Update cache (only for sync rendering)
				if (!shouldUseParallelRender && source) {
					astCache.set(sourceFile.fileName, {
						sourceHash,
						output: source,
						dependencies,
					});
				}

				modifiedFiles.add(sourceFile.fileName);
			}

			// Only push to write queue if we rendered synchronously
			if (source !== undefined) {
				fileWriteQueue.push({ sourceFile, source });
			}
		});
	}

	if (DiagnosticService.hasErrors()) return { emitSkipped: true, diagnostics: DiagnosticService.flush() };

	// Batch render ASTs in parallel if enabled
	if (renderJobs.length > 0) {
		await benchmarkIfVerbose("rendering ASTs in parallel", async () => {
			try {
				const workerPool = getOrCreateWorkerPool(data);
				LogService.writeLineIfVerbose(
					`rendering ${renderJobs.length} files using ${workerPool.getWorkerCount()} workers`,
				);

				const renderResults = await workerPool.renderAll(
					renderJobs.map(job => ({ id: job.id, luauAST: job.luauAST })),
				);

				// Sort by ID to maintain order and push to write queue
				for (const result of renderResults.sort((a, b) => a.id - b.id)) {
					const job = renderJobs[result.id];
					fileWriteQueue.push({ sourceFile: job.sourceFile, source: result.source });

					// Update cache with rendered output
					const sourceText = job.sourceFile.getFullText();
					const sourceHash = createHash("sha256").update(sourceText).digest("hex");
					const dependencies = new Set<string>();
					const resolvedModules = (job.sourceFile as any).resolvedModules as
						| Map<string, ts.ResolvedModuleFull | undefined>
						| undefined;
					if (resolvedModules) {
						resolvedModules.forEach((resolved: ts.ResolvedModuleFull | undefined) => {
							if (resolved?.resolvedFileName) {
								dependencies.add(resolved.resolvedFileName);
							}
						});
					}
					astCache.set(job.sourceFile.fileName, {
						sourceHash,
						output: result.source,
						dependencies,
					});
				}
			} catch (error) {
				// If parallel rendering fails, fall back to synchronous rendering
				LogService.warn(`Parallel rendering failed, falling back to synchronous: ${error}`);
				for (const job of renderJobs) {
					const source = renderAST(job.luauAST);
					fileWriteQueue.push({ sourceFile: job.sourceFile, source });
				}
			}
		});
	}

	const emittedFiles = new Array<string>();
	if (fileWriteQueue.length > 0) {
		await benchmarkIfVerbose("writing compiled files", async () => {
			const afterDeclarations = compilerOptions.declaration
				? [transformTypeReferenceDirectives, transformPathsTransformer(program, {})]
				: undefined;

			// Parallelize file writes with hash-based change detection
			const writePromises = fileWriteQueue.map(async ({ sourceFile, source }) => {
				const outPath = pathTranslator.getOutputPath(sourceFile.fileName);
				const sourceHash = createHash("sha256").update(source).digest("hex");

				let needsWrite = !data.projectOptions.writeOnlyChanged;
				if (!needsWrite) {
					const cachedHash = fileHashCache.get(outPath);
					if (!cachedHash || cachedHash !== sourceHash) {
						needsWrite = true;
					}
				}

				if (needsWrite) {
					await fs.outputFile(outPath, source);
					fileHashCache.set(outPath, sourceHash);

					if (compilerOptions.declaration) {
						proxyProgram.emit(sourceFile, ts.sys.writeFile, undefined, true, { afterDeclarations });
					}

					return outPath;
				}

				return undefined;
			});

			const results = await Promise.all(writePromises);
			emittedFiles.push(...results.filter((path): path is string => path !== undefined));
		});
	}

	program.emitBuildInfo();

	return { emittedFiles, emitSkipped: false, diagnostics: DiagnosticService.flush() };
}
