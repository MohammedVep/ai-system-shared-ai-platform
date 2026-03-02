import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEnv } from "../../config/env.js";
import { ModelRouter } from "../model/modelRouter.js";
import { redactPii } from "../policy/guardrails.js";

type EvalCase = {
  id: string;
  input: string;
  expected_keywords: string[];
};

const scoreCase = (output: string, expectedKeywords: string[]): number => {
  if (expectedKeywords.length === 0) {
    return 1;
  }

  const matches = expectedKeywords.filter((keyword) => output.includes(keyword)).length;
  return matches / expectedKeywords.length;
};

const run = async (): Promise<void> => {
  const env = loadEnv();
  const modelRouter = new ModelRouter(env);
  const datasetPath = join(process.cwd(), "eval-datasets", "sample.json");
  const raw = await readFile(datasetPath, "utf8");
  const cases = JSON.parse(raw) as EvalCase[];

  const results = [] as Array<{ id: string; score: number; output: string }>;
  for (const c of cases) {
    const modelResult = await modelRouter.generate({
      projectId: "eval",
      traceId: `trace-${c.id}`,
      runId: `run-${c.id}`,
      messages: [
        { role: "system", content: "Answer in one short sentence." },
        { role: "user", content: c.input }
      ]
    });

    const sanitized = redactPii(modelResult.text);
    const score = scoreCase(sanitized, c.expected_keywords);
    results.push({
      id: c.id,
      score,
      output: sanitized
    });
  }

  const avg = results.reduce((acc, item) => acc + item.score, 0) / results.length;
  console.log(
    JSON.stringify(
      {
        total: results.length,
        average_score: Number(avg.toFixed(3)),
        results
      },
      null,
      2,
    ),
  );
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
