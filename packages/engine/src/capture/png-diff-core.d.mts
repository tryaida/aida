export interface PngDiffResult {
  changedFraction: number;
  dimensionsMatch: boolean;
}

export function diffPngBuffers(a: Buffer, b: Buffer, perChannelTolerance: number): PngDiffResult;
export function buffersEqual(a: Buffer, b: Buffer): boolean;
