import { RPC_WRITE_FRAME_LIMIT_BYTES, rpcFrameBytes } from '../../../src/lib/rpc-frame'
import type { RpcObject } from './types'

export const MAX_RPC_WRITE_FRAME_BYTES = RPC_WRITE_FRAME_LIMIT_BYTES

export function rpcRequestFrameBytes(command: RpcObject): number {
  return rpcFrameBytes(command)
}
