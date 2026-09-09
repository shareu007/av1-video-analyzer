export const DEMO_SAMPLE_NAME = "av1scope-demo-16x16.ivf";

const DEMO_SAMPLE_BASE64 = "REtJRgAAIABBVjAxEAAQAAEAAAABAAAAAQAAAAAAAAAYAAAAAAAAAAAAAAASAAoGGAz/2gCAMgwYAAAAUAAAAKmOWNQ=";

export function demoSampleBytes() {
  const binary = atob(DEMO_SAMPLE_BASE64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
