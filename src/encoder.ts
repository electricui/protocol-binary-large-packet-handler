import { Message, Pipeline } from '@electricui/core'
import { CancellationToken } from '@electricui/async-utilities'

import { TYPES } from '@electricui/protocol-binary-constants'

export interface BinaryLargePacketHandlerEncoderOptions {
  maxPayloadLength: number
}

const dEncoder = require('debug')('electricui-protocol-binary-large-packet-handler:encoder')

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

  async receive(message: Message, cancellationToken: CancellationToken) {
    // Null payloads go immediately
    if (message.payload === null) {
      return this.push(message, cancellationToken)
    }

    // Check to make sure that the payload is actually a buffer
    if (!Buffer.isBuffer(message.payload)) {
      throw new TypeError(
        'BinaryLargePacketHandlerEncoder needs to be sitting after codecs. Received a non-binary packet.',
      )
    }

    // If the packet is under the size threshold, just push it on
    if (message.payload.length <= this.maxPayloadLength) {
      return this.push(message, cancellationToken)
    }

    // If the packet already has an offset, push it on
    if (message.metadata.offset !== null) {
      dEncoder('encountered a packet that already had an offset')
      return this.push(message, cancellationToken)
    }

    // Create the start packet
    const payload = Buffer.allocUnsafe(4)
    payload.writeUInt16LE(0, 0)
    payload.writeUInt16LE(message.payload.byteLength, 2)
    const offsetTransferStartPacket = new Message(message.messageID, payload)
    offsetTransferStartPacket.metadata.type = TYPES.OFFSET_METADATA
    offsetTransferStartPacket.metadata.internal = message.metadata.internal

    // Send the start packet
    const promises = [this.push(offsetTransferStartPacket, cancellationToken)]

    // Create the pieces
    const splitter = splitBigPacket(message.payload, this.maxPayloadLength)
    for (const splitPacket of splitter) {
      const newPacket = new Message(message.messageID, splitPacket.payload)
      newPacket.metadata = Object.assign({}, message.metadata) // copy all metadata
      newPacket.metadata.offset = splitPacket.offset

      // send all the parts
      promises.push(this.push(newPacket, cancellationToken))
    }

    await Promise.all(promises)
  }
}
