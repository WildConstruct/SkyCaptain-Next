// Types for the vendored Prompt Spaghetti evaluator (see tools/build-psg-eval.mjs).
type VariableValue = string | number | boolean;
export interface EvaluatePsgPick {
  index: number;
  optionId?: string;
  name?: string;
  text: string;
  meta?: Record<string, unknown>;
}
export interface EvaluatePsgResult {
  success: boolean;
  graphSha256: string;
  output: string;
  variables: Record<string, VariableValue>;
  picks: Record<string, EvaluatePsgPick>;
  errors: string[];
  warnings: string[];
}
export function evaluatePsg(
  source: string,
  options?: { seed?: string | number; locks?: Record<string, VariableValue>; choiceLocks?: Record<string, string> },
): Promise<EvaluatePsgResult>;
