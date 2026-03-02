import vm from "node:vm";
import { MiniLoadBalancer } from "../ops/miniLoadBalancer.js";

export type CodeExecutionResult = {
  output: string;
  worker: string;
};

type WorkerNode = {
  id: string;
  execute: (code: string, timeoutMs: number) => Promise<string>;
};

const localWorker = (id: string): WorkerNode => ({
  id,
  execute: async (code, timeoutMs) => {
    const sandbox = {
      console: {
        output: [] as string[],
        log: (...args: unknown[]) => {
          sandbox.console.output.push(args.map(String).join(" "));
        }
      }
    };

    const context = vm.createContext(sandbox);
    const script = new vm.Script(code);
    const result = script.runInContext(context, { timeout: timeoutMs });

    const printed = sandbox.console.output.join("\n");
    if (printed.length > 0) {
      return printed;
    }
    return result === undefined ? "" : String(result);
  }
});

export class CloudCodeExecutionService {
  private readonly balancer: MiniLoadBalancer<WorkerNode>;

  constructor() {
    this.balancer = new MiniLoadBalancer<WorkerNode>([localWorker("edge-1"), localWorker("edge-2")]);
  }

  async execute(code: string, timeoutMs = 1500): Promise<CodeExecutionResult> {
    const node = this.balancer.next();
    const output = await node.execute(code, timeoutMs);
    return {
      output,
      worker: node.id
    };
  }

  workerCount(): number {
    return this.balancer.size();
  }
}
