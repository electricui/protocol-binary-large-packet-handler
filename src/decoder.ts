import { DuplexPipeline, Message, Pipeline, TypeCache } from '@electricui/core'
import { MESSAGEIDS, TYPES } from '@electricui/protocol-binary-constants'
import { OffsetMetadataCodec } from '@electricui/protocol-binary-codecs'
import { IntervalTree } from 'node-interval-tree'

export interface BinaryLargePacketHandlerDecoderOptions {
  loopTime: number
}

const dDecoder = require('debug')(
  'electricui-protocol-binary-large-packet-handler:decoder',
)

class LargePacketInternalBuffer {
  buffer: Buffer
  receivedRanges = new IntervalTree()
  constructor(size: number) {
    this.buffer = Buffer.alloc(size)
  }
}

/**
 * BinaryLargePacketHandlerDecoder decodes large packets
 */
export default class BinaryLargePacketHandlerDecoder extends Pipeline {
  loopTime: number
  metadataCodec = new OffsetMetadataCodec()
  buffers: {
    [messageID: string]: LargePacketInternalBuffer
  } = {}

  constructor(options: BinaryLargePacketHandlerDecoderOptions) {
    super()
    this.loopTime = options.loopTime
  }

  private allocateBuffer(messageID: string, size: number) {
    this.buffers[messageID] = new LargePacketInternalBuffer(size)
  }

  private deleteBuffer(messageID: string) {
    delete this.buffers[messageID]
  }

  private getBuffer(messageID: string) {
    return this.buffers[messageID] || null
  }

  private hasBuffer(messageID: string) {
    return this.getBuffer(messageID) !== null
  }

  private processOffsetMetadataPacket(message: Message) {
    if (this.hasBuffer(message.messageID)) {
      console.error(
        `Received an offset metadata message for a messageID, ${
          message.messageID
        } that already has a buffer.`,
      )
      return Promise.resolve()
    }

    // Allocate a buffer that is the size of the message

    const size = message.payload.end - message.payload.start

    this.allocateBuffer(message.metadata.messageID, size)

    return Promise.resolve()
  }

  receive(message: Message) {
    // Null payloads go immediately
    if (message.payload === null) {
      return this.push(message)
    }

    // If the packet already has an offset, push it on
    if (message.metadata.offset !== null) {
      dDecoder('encountered a packet that already had an offset')
      return this.push(message)
    }

    // if it's a offset metadata packet, allocate the space for it
    if (message.metadata.type === TYPES.OFFSET_METADATA) {
      // Decode the packet, then call our processOffsetMetadataPacket function with the message, passing the promise through the chain.

      // This doesn't happen automatically because of the ordering of the codec pipeline versus this pipeline
      return this.metadataCodec.decode(
        message,
        this.processOffsetMetadataPacket,
      )
    }

    return this.push(message)
  }
}
