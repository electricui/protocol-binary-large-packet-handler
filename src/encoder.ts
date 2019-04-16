import { Message, Pipeline } from '@electricui/core'
import { TYPES } from '@electricui/protocol-binary-constants'

export interface BinaryLargePacketHandlerEncoderOptions {
  maxPayloadLength: number
}

const dEncoder = require('debug')(
  'electricui-protocol-binary-large-packet-handler:encoder',
)

// A generator function that splits a buffer into small pieces
function* splitBigPacket(buf: Buffer, maxPacketSize: number) {
  let offset = 0
  let done = false

  while (!done) {
    const start = offset
    const end = Math.min(offset + maxPacketSize, buf.length)
    offset = end

    done = end === buf.length

    yield {
      offset: start,
      payload: buf.slice(start, end),
    }
  }
}

/**
 * BinaryLargePacketHandlerEncoder encodes large packets
 */
export default class BinaryLargePacketHandlerEncoder extends Pipeline {
  maxPayloadLength: number

  constructor(options: BinaryLargePacketHandlerEncoderOptions) {
    super()
    this.maxPayloadLength = options.maxPayloadLength
  }

  receive(message: Message) {
    // Null payloads go immediately
    if (message.payload === null) {
      return this.push(message)
    }

    // Check to make sure that the payload is actually a buffer
    if (!Buffer.isBuffer(message.payload)) {
      throw new TypeError(
        'BinaryLargePacketHandlerEncoder needs to be sitting after codecs. Received a non-binary packet.',
      )
    }

    // If the packet is under the size threshold, just push it on
    if (message.payload.length <= this.maxPayloadLength) {
      return this.push(message)
    }

    // If the packet already has an offset, push it on
    if (message.metadata.offset !== null) {
      dEncoder('encountered a packet that already had an offset')
      return this.push(message)
    }

    // Create the start packet
    const offsetTransferStartPacket = new Message(
      message.messageID,
      Buffer.from(Uint16Array.from([0, 10]).buffer),
    )
    offsetTransferStartPacket.metadata.type = TYPES.OFFSET_METADATA
    offsetTransferStartPacket.metadata.internal = message.metadata.internal

    // Send the start packet
    const promises = [this.push(offsetTransferStartPacket)]

    // Create the pieces
    const splitter = splitBigPacket(message.payload, this.maxPayloadLength)
    for (const splitPacket of splitter) {
      const newPacket = new Message(message.messageID, splitPacket.payload)
      newPacket.metadata = message.metadata // copy all metadata
      newPacket.metadata.offset = splitPacket.offset

      // send all the parts
      promises.push(this.push(newPacket))
    }

    return Promise.all(promises)
  }
}
