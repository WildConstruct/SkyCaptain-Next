// Types for src/moniker/skycaptain.js.
import type { Settings } from '../settings';
import type { ShapeLayer } from '../shapes';
export interface Description { suggestion: string; fallback: string; tokens: string[]; vocabulary: string }
export interface MonikerBlock { id: string; fallback: string; tokens: string[]; vocabulary: string }
export function timeFamily(sunElevation: number): string;
export function moodFamily(density: number, ambient: number, powder: number, forwardG: number): string;
export function sceneFamily(shapes: ShapeLayer[], hasPaint: boolean): string;
export function lookMonikerState(settings: Settings): Record<string, unknown>;
export function skyMonikerState(settings: Settings, shapes: ShapeLayer[], hasPaint: boolean): Record<string, unknown>;
export const DERIVED_STATE: string[];
export function describeLook(settings: Settings, vocabulary: unknown, existingNames?: string[]): Description;
export function describeSky(settings: Settings, shapes: ShapeLayer[], hasPaint: boolean, vocabulary: unknown, existingNames?: string[]): Description;
export function monikerBlock(id: string, description: Description): MonikerBlock;
