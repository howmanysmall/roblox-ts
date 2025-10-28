import { LogService } from "Shared/classes/LogService";

function benchmarkStart(name: string) {
	LogService.write(`${name}`);
	return Date.now();
}

function benchmarkEnd(startTime: number) {
	LogService.write(` ( ${Date.now() - startTime} ms )\n`);
}

export function benchmarkSync(name: string, callback: () => void) {
	const startTime = benchmarkStart(name);
	callback();
	benchmarkEnd(startTime);
}

export function benchmarkIfVerbose(name: string, callback: () => void): void;
export function benchmarkIfVerbose<T>(name: string, callback: () => Promise<T>): Promise<T>;
export function benchmarkIfVerbose<T>(name: string, callback: () => void | Promise<T>): void | Promise<T> {
	if (LogService.verbose) {
		const startTime = benchmarkStart(name);
		const result = callback();
		if (result instanceof Promise) {
			return result.then(value => {
				benchmarkEnd(startTime);
				return value;
			});
		} else {
			benchmarkEnd(startTime);
			return result;
		}
	} else {
		return callback();
	}
}

export async function benchmark<T>(name: string, callback: () => Promise<T>) {
	const startTime = benchmarkStart(name);
	await callback();
	benchmarkEnd(startTime);
}
