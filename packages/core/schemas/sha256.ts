/**
 * SHA-256 (FIPS 180-4), synchronous, over the UTF-8 bytes of a string.
 *
 * Derived record ids are computed inside sync apply's transaction and inside
 * storage writes, which are synchronous in both runtimes. `crypto.subtle` is
 * async, and `node:crypto` is not reachable from the hub's path, so core
 * carries the digest itself. `sha256.test.ts` holds it to the standard's
 * vectors.
 */

const K = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** The 64-word message schedule of the block at `offset`. */
const schedule = (view: DataView, offset: number): number[] => {
	const w: number[] = [];
	for (let i = 0; i < 16; i++) w.push(view.getUint32(offset + i * 4));
	for (let i = 16; i < 64; i++) {
		const a = w[i - 15] ?? 0;
		const b = w[i - 2] ?? 0;
		const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
		const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
		w.push(((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0);
	}
	return w;
};

/** Fold one block's schedule into `hash`, in place. */
const compress = (hash: number[], w: readonly number[]): void => {
	let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = hash;
	for (let i = 0; i < 64; i++) {
		const t1 =
			(h +
				(rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
				((e & f) ^ (~e & g)) +
				(K[i] ?? 0) +
				(w[i] ?? 0)) >>>
			0;
		const t2 =
			((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
				((a & b) ^ (a & c) ^ (b & c))) >>>
			0;
		h = g;
		g = f;
		f = e;
		e = (d + t1) >>> 0;
		d = c;
		c = b;
		b = a;
		a = (t1 + t2) >>> 0;
	}
	for (const [i, word] of [a, b, c, d, e, f, g, h].entries())
		hash[i] = ((hash[i] ?? 0) + word) >>> 0;
};

/** Lowercase hex digest of `text`'s UTF-8 bytes. */
export const sha256Hex = (text: string): string => {
	const bytes = new TextEncoder().encode(text);
	const length = Math.ceil((bytes.length + 9) / 64) * 64;
	const padded = new Uint8Array(length);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const view = new DataView(padded.buffer);
	const bits = bytes.length * 8;
	view.setUint32(length - 8, Math.floor(bits / 0x100000000));
	view.setUint32(length - 4, bits >>> 0);

	const hash = [
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
		0x1f83d9ab, 0x5be0cd19,
	];
	for (let block = 0; block < length; block += 64)
		compress(hash, schedule(view, block));
	return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
};
