export function exhaustive(x: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(x)}`);
}
