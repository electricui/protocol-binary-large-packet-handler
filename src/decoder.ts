import { DuplexPipeline, Message, Pipeline, TypeCache } from '@electricui/core'
import { MESSAGEIDS, TYPES } from '@electricui/protocol-binary-constants'
import { OffsetMetadataCodec } from '@electricui/protocol-binary-codecs'
import { IntervalTree, Interval } from 'node-interval-tree'

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

    this.updateProgress = this.updateProgress.bind(this)
    this.getProgress = this.getProgress.bind(this)
    this.getRangesNotReceived = this.getRangesNotReceived.bind(this)
    this.getTotal = this.getTotal.bind(this)
    this.addData = this.addData.bind(this)
    this.getData = this.getData.bind(this)
  }

  private updateProgress(start: number, end: number) {
    // find any overlaps
    const overlaps = this.receivedRanges.search(start, end)

    let min = start
    let max = end

    for (const overlap of overlaps) {
      // set our new ranges
      min = Math.min(min, overlap.low)
      max = Math.max(max, overlap.high)

      // remove the old interval
      this.receivedRanges.remove(overlap)
    }

    // insert our new interval
    this.receivedRanges.insert({
      low: min,
      high: max,
    })
  }

  public getProgress() {
    let progress = 0

    // For every stored interval, we add up the bytes received
    for (const interval of this.receivedRanges.inOrder()) {
      progress += interval.high - interval.low
    }

    return progress
  }

  public getRangesNotReceived() {
    let cursor = 0

    const inverseProgress: Interval[] = []

    for (const interval of this.receivedRanges.inOrder()) {
      // For every range received, run a cursor over it, if the cursor isn't at the low point, we're missing
      // some data, push an interval of missing data from the cursor's last position to the end of the data
      // received in this interval
      if (cursor < interval.low) {
        inverseProgress.push({
          low: cursor,
          high: interval.low,
        })
      }
      cursor = interval.high
    }

    // If there's data left over at the right side, push an interval for that too
    if (cursor < this.getTotal()) {
      inverseProgress.push({
        low: cursor,
        high: this.getTotal(),
      })
    }

    return inverseProgress
  }

  public getTotal() {
    return this.buffer.length
  }

  public addData(offset: number, payload: Buffer) {
    // Update the actual buffer
    payload.copy(this.buffer, offset)

    // Update our progress
    this.updateProgress(offset, offset + payload.length)
  }

  public getData() {
    return this.buffer
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

    this.allocateBuffer = this.allocateBuffer.bind(this)
    this.deleteBuffer = this.deleteBuffer.bind(this)
    this.getBuffer = this.getBuffer.bind(this)
    this.hasBuffer = this.hasBuffer.bind(this)
    this.processOffsetMetadataPacket = this.processOffsetMetadataPacket.bind(this) // prettier-ignore
    this.receive = this.receive.bind(this)
  }

  private allocateBuffer(messageID: string, size: number) {
    dDecoder(`Allocating a buffer for ${messageID} of size ${size} bytes`)
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
    dDecoder(
      'Decoded an offset metadata message',
      message.messageID,
      message.payload,
    )
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

    this.allocateBuffer(message.messageID, size)

    return Promise.resolve()
  }

  receive(message: Message) {
    // Null payloads go immediately
    if (message.payload === null) {
      return this.push(message)
    }

    // If the packet has no offset, and it's not an offset metadata packet, push it on
    if (
      message.metadata.offset === null &&
      message.metadata.type !== TYPES.OFFSET_METADATA
    ) {
      // dDecoder('encountered a packet with no offset')
      return this.push(message)
    }

    // If the packet is a callback, push it on, this should never happen.
    if (message.metadata.type === TYPES.CALLBACK) {
      dDecoder('encountered a non-null callback packet?', message)
      return this.push(message)
    }

    // if it's a offset metadata packet, allocate the space for it
    if (message.metadata.type === TYPES.OFFSET_METADATA) {
      // Decode the packet, then call our processOffsetMetadataPacket function with the message, passing the promise through the chain.

      dDecoder(
        'received the start of an offset data transfer',
        message.messageID,
      )

      // This doesn't happen automatically because of the ordering of the codec pipeline versus this pipeline
      return this.metadataCodec.decode(
        message,
        this.processOffsetMetadataPacket,
      )
    }

    // it's an offset packet

    // if we haven't allocated a buffer yet, error
    if (!this.hasBuffer(message.messageID)) {
      console.error(
        `Received an offset packet for messageID, ${
          message.messageID
        } that doesn't have a buffer allocated.`,
      )

      return Promise.reject()
    }

    // we have a packet, and a buffer allocated, place it in the buffer
    const buffer = this.getBuffer(message.messageID)

    buffer.addData(message.metadata.offset, message.payload)

    // check progress
    const progress = buffer.getProgress()
    const total = buffer.getTotal()

    // TODO: send a progress update

    // if it's complete, send the full packet
    if (progress === total) {
      // Create a new message
      const completeMessage = new Message(message.messageID, buffer.getData())

      // 'Copy' the metadata
      completeMessage.metadata = message.metadata

      // We're no longer an offset packet
      completeMessage.metadata.offset = null

      // Push the completed message up the pipeline
      return this.push(completeMessage)
    }

    // print the progress
    dDecoder(`Progress:`, buffer.getRangesNotReceived())

    // We have dealt with the message
    return Promise.resolve()
  }
}
