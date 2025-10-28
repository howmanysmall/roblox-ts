import { MacroManager } from "TSTransformer";
import { TransformServices } from "TSTransformer/types";
import ts from "typescript";

// Cache MacroManager per TypeChecker instance to avoid expensive re-initialization
const macroManagerCache = new WeakMap<ts.TypeChecker, MacroManager>();

export function createTransformServices(typeChecker: ts.TypeChecker): TransformServices {
	let macroManager = macroManagerCache.get(typeChecker);
	if (!macroManager) {
		macroManager = new MacroManager(typeChecker);
		macroManagerCache.set(typeChecker, macroManager);
	}

	return { macroManager };
}
