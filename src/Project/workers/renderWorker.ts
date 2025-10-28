import { renderAST } from "@roblox-ts/luau-ast";
import luau from "@roblox-ts/luau-ast";
import { parentPort } from "worker_threads";

interface RenderJobMessage {
	id: number;
	luauAST: luau.List<luau.Statement>;
}

interface RenderResultMessage {
	id: number;
	source: string;
	error?: string;
}

if (parentPort) {
	parentPort.on("message", (data: RenderJobMessage) => {
		const { id, luauAST } = data;
		try {
			const source = renderAST(luauAST);
			parentPort!.postMessage({ id, source } as RenderResultMessage);
		} catch (error) {
			parentPort!.postMessage({
				id,
				source: "",
				error: error instanceof Error ? error.message : String(error),
			} as RenderResultMessage);
		}
	});
}
