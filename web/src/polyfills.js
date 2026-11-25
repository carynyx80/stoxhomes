// @solana/web3.js and spl-token expect a global Buffer in the browser.
import { Buffer } from "buffer";
if (!globalThis.Buffer) globalThis.Buffer = Buffer;
