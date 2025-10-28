import luau from "@roblox-ts/luau-ast";
import os from "os";
import path from "path";
import { PACKAGE_ROOT } from "Shared/constants";
import { Worker } from "worker_threads";

interface RenderJob {
	id: number;
	luauAST: luau.List<luau.Statement>;
	resolve: (source: string) => void;
	reject: (error: Error) => void;
}

interface RenderJobMessage {
	id: number;
	luauAST: luau.List<luau.Statement>;
}

interface RenderResultMessage {
	id: number;
	source: string;
	error?: string;
}

export class WorkerPool {
	private workers: Worker[] = [];
	private jobQueue: RenderJob[] = [];
	private activeJobs = new Map<number, RenderJob>();
	private nextJobId = 0;
	private roundRobinIndex = 0;
	private destroyed = false;

	constructor(workerCount?: number) {
		const count = workerCount ?? Math.max(1, os.cpus().length - 1);
		const workerPath = path.join(PACKAGE_ROOT, "out", "Project", "workers", "renderWorker.js");

		for (let i = 0; i < count; i++) {
			try {
				const worker = new Worker(workerPath);
				worker.on("message", this.handleWorkerMessage.bind(this));
				worker.on("error", this.handleWorkerError.bind(this));
				this.workers.push(worker);
			} catch (error) {
				// If worker creation fails, continue with fewer workers
				console.warn(`Failed to create worker ${i + 1}/${count}:`, error);
			}
		}

		// If no workers were created, throw
		if (this.workers.length === 0) {
			throw new Error("Failed to create any worker threads");
		}
	}

	async render(luauAST: luau.List<luau.Statement>): Promise<string> {
		if (this.destroyed) {
			throw new Error("WorkerPool has been destroyed");
		}

		return new Promise((resolve, reject) => {
			const job: RenderJob = {
				id: this.nextJobId++,
				luauAST,
				resolve,
				reject,
			};
			this.jobQueue.push(job);
			this.processQueue();
		});
	}

	async renderAll(
		jobs: Array<{ id: number; luauAST: luau.List<luau.Statement> }>,
	): Promise<Array<{ id: number; source: string }>> {
		const promises = jobs.map(job => this.render(job.luauAST).then(source => ({ id: job.id, source })));
		return Promise.all(promises);
	}

	private processQueue() {
		// Process queue with backpressure: limit active jobs to 2x worker count
		const maxActiveJobs = this.workers.length * 2;

		while (this.jobQueue.length > 0 && this.activeJobs.size < maxActiveJobs) {
			const job = this.jobQueue.shift()!;
			this.activeJobs.set(job.id, job);

			const worker = this.workers[this.roundRobinIndex];
			this.roundRobinIndex = (this.roundRobinIndex + 1) % this.workers.length;

			const message: RenderJobMessage = {
				id: job.id,
				luauAST: job.luauAST,
			};

			worker.postMessage(message);
		}
	}

	private handleWorkerMessage(data: RenderResultMessage) {
		const { id, source, error } = data;
		const job = this.activeJobs.get(id);
		if (!job) return;

		this.activeJobs.delete(id);

		if (error) {
			job.reject(new Error(`Render failed: ${error}`));
		} else {
			job.resolve(source);
		}

		this.processQueue();
	}

	private handleWorkerError(error: Error) {
		// Reject all active jobs when a worker errors
		for (const [id, job] of this.activeJobs) {
			job.reject(new Error(`Worker error: ${error.message}`));
			this.activeJobs.delete(id);
		}

		// Reject all queued jobs
		for (const job of this.jobQueue) {
			job.reject(new Error(`Worker error: ${error.message}`));
		}
		this.jobQueue = [];
	}

	async destroy() {
		if (this.destroyed) return;

		this.destroyed = true;

		// Reject all pending jobs
		for (const job of this.jobQueue) {
			job.reject(new Error("WorkerPool destroyed"));
		}
		this.jobQueue = [];

		for (const [, job] of this.activeJobs) {
			job.reject(new Error("WorkerPool destroyed"));
		}
		this.activeJobs.clear();

		// Terminate all workers
		await Promise.all(this.workers.map(worker => worker.terminate()));
		this.workers = [];
	}

	getWorkerCount() {
		return this.workers.length;
	}
}
