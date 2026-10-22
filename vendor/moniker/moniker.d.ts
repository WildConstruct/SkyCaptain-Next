// Types for the vendored Moniker Core (vendor/moniker/moniker.js).
export interface FiredToken { slot: string; token: string; weight: number; required: boolean; order: number }
export function slotToken(slot: unknown, value: unknown): string | null;
export function firedTokens(state: Record<string, unknown>, vocabulary: unknown): FiredToken[];
export function generateName(state: Record<string, unknown>, vocabulary: unknown, existingNames?: string[]): string;
