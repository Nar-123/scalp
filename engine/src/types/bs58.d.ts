// bs58@4 ships no type declarations, and @types/bs58 is a stub pointing at a
// newer bs58 major that publishes its own types (which our pinned v4 does
// not). Minimal ambient declaration for the two functions this codebase uses.
declare module 'bs58' {
  interface Bs58 {
    decode(input: string): Uint8Array;
    encode(input: Uint8Array | number[] | Buffer): string;
  }
  const bs58: Bs58;
  export default bs58;
}
