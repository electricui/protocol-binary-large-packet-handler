import { Message, Pipeline, ConnectionInterface } from '@electricui/core'
import { TYPES } from '@electricui/protocol-binary-constants'
import { OffsetMetadataCodec } from '@electricui/protocol-binary-codecs'
import { IntervalTree, Interval } from 'node-interval-tree'

export interface BinaryLargePacketHandlerDecoderOptions {
  loopTime?: number
  fixedGraceTime?: number
  connectionInterface: ConnectionInterface
  externalTiming?: boolean
}

const dDecoder = require('debug')(
  'electricui-protocol-binary-large-packet-handler:decoder',
)

type getTimeFunc = () => number

class LargePacketInternalBuffer {
  buffer: Buffer
  receivedRanges = new IntervalTree()
  getTime: getTimeFunc
  timings: number[] = []
  circularTimingsBuffer = 20 // Just to avoid memory leaks

  constructor(size: number, getTime: getTimeFunc) {
    this.buffer = Buffer.alloc(size)
    this.getTime = getTime

    this.updateTimings = this.updateTimings.bind(this)
    this.updateProgress = this.updateProgress.bind(this)
    this.getProgress = this.getProgress.bind(this)
    this.getRangesNotReceived = this.getRangesNotReceived.bind(this)
    this.getTotal = this.getTotal.bind(this)
    this.addData = this.addData.bind(this)
    this.getData = this.getData.bind(this)
    this.getAverageTimeBetweenPackets = this.getAverageTimeBetweenPackets.bind(
      this,
    )
    this.getLastTimeReceived = this.getLastTimeReceived.bind(this)
    this.getDurationOfTransfer = this.getDurationOfTransfer.bind(this)
  }

  public getLastTimeReceived() {
    return this.timings[this.timings.length - 1]
  }

  private updateTimings() {
    // Cap the progess timing data
    if (this.timings.length > this.circularTimingsBuffer) {
      this.timings.shift()
    }

    this.timings.push(this.getTime())
  }

  public getDurationOfTransfer() {
    const firstTiming = this.timings[0]
    const lastTiming = this.getLastTimeReceived()

    if (
      typeof firstTiming === 'undefined' ||
      typeof lastTiming === 'undefined'
    ) {
      return 0
    }

    return lastTiming - firstTiming
  }

  public getAverageTimeBetweenPackets() {
    if (this.timings.length < 2) {
      return null
    }

    // Iterate over every 'pair', by starting with the second element and iterating over the rest
    // to find the differences in the timings, then reduce it to a sum, then divide it by the length to get an average

    const sum = this.timings
      .slice(1) // remove the first element
      .map((prevTime, index) => {
        const nextTime = this.timings[index + 1]

        return nextTime - prevTime
      })
      .reduce((a, b) => a + b)

    return sum / (this.timings.length - 1)
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

    // Update our timings
    this.updateTimings()

    dDecoder('added ', payload.length, ' bytes of data data at offset', offset)
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
  fixedGraceTime: number
  metadataCodec = new OffsetMetadataCodec()
  buffers: {
    [messageID: string]: LargePacketInternalBuffer
  } = {}
  metadata: {
    [messageID: string]: any
  } = {}
  lastRequestBatchTime: {
    [messageID: string]: number
  } = {}
  connectionInterface: ConnectionInterface
  externalTiming: boolean
  timer: NodeJS.Timer | null = null

  constructor(options: BinaryLargePacketHandlerDecoderOptions) {
    super()
    this.loopTime = options.loopTime || 16
    this.fixedGraceTime = options.fixedGraceTime || 50
    this.connectionInterface = options.connectionInterface
    this.externalTiming = options.externalTiming || false

    this.allocateBuffer = this.allocateBuffer.bind(this)
    this.deleteBuffer = this.deleteBuffer.bind(this)
    this.getBuffer = this.getBuffer.bind(this)
    this.hasBuffer = this.hasBuffer.bind(this)
    this.processOffsetMetadataPacket = this.processOffsetMetadataPacket.bind(this) // prettier-ignore
    this.receive = this.receive.bind(this)
    this.tick = this.tick.bind(this)
    this._getTime = this._getTime.bind(this)
    this.getTime = this.getTime.bind(this)
  }

  /**
   * Override this in the tests
   */
  public _getTime() {
    return new Date().getTime()
  }

  private getTime() {
    return this._getTime()
  }

  onConnecting() {
    dDecoder(`Large packet decoder onConnect`)

    if (!this.externalTiming) {
      this.timer = setInterval(this.tick, this.loopTime)
    }
  }

  onDisconnecting() {
    dDecoder(`Large packet decoder onDisconnect`)

    if (this.timer) {
      clearTimeout(this.timer)
    }
  }

  public tick() {
    const now = this.getTime()

    // iterate over all the messageIDs we're storing
    for (const messageID of Object.keys(this.buffers)) {
      const buffer = this.buffers[messageID]

      const averageTime = buffer.getAverageTimeBetweenPackets()

      if (averageTime === null) {
        continue
      }

      dDecoder(
        `Average time between packets for ${messageID} is ${averageTime}ms`,
      )

      const lastTimeRequestedBatch = this.lastRequestBatchTime[messageID]

      // if the time between now and the last batch request is below our threshold, don't ask again
      if (
        now - lastTimeRequestedBatch <
        averageTime * 3 + this.fixedGraceTime
      ) {
        continue
      }

      const progress = buffer.getProgress()
      const total = buffer.getTotal()
      const remaining = total - progress
      const lastTimeReceived = buffer.getLastTimeReceived()

      const expectedTimeToFinish =
        lastTimeReceived + (averageTime / progress) * remaining

      // If we expect it to _be finished_ by now, request the remainder of the data again
      if (expectedTimeToFinish + this.fixedGraceTime < now) {
        for (const range of buffer.getRangesNotReceived()) {
          this.requestRange(messageID, range.low, range.high)
        }

        // now is the last time we requested a batch
        this.lastRequestBatchTime[messageID] = this.getTime()
      }
    }
  }

  private allocateBuffer(message: Message, size: number) {
    const messageID = message.messageID

    dDecoder(`Allocating a buffer for ${messageID} of size ${size} bytes`)
    this.buffers[messageID] = new LargePacketInternalBuffer(size, this.getTime)

    dDecoder(`Recording metadata for ${messageID}`)
    this.metadata[messageID] = Object.assign({}, message.metadata)

    // Setup when we last requested the batch. It was 'roughly now'
    this.lastRequestBatchTime[messageID] = this.getTime()
  }

  private deleteBuffer(messageID: string) {
    delete this.buffers[messageID]
    delete this.metadata[messageID]
    delete this.lastRequestBatchTime[messageID]
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

    this.allocateBuffer(message, size)

    return Promise.resolve()
  }

  private requestRange(messageID: string, start: number, end: number) {
    dDecoder('Requesting the range of', messageID, 'from', start, 'to', end)

    // The message is encoded by the codecs pipeline since it's passed back up through the entire connectionInterface
    const message = new Message(messageID, {
      start,
      end,
    })

    message.metadata = Object.assign({}, this.metadata[messageID], {
      query: true,
      offset: null,
      type: TYPES.OFFSET_METADATA,
      ack: false, // TODO: Ack this and deal with it in a more clever manner
      ackNum: 0,
    })

    return this.connectionInterface.write(message)
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
      dDecoder(
        `completed a packet for ${
          message.messageID
        } which took ${buffer.getDurationOfTransfer()}ms`,
      )

      // Create a new message
      const completeMessage = new Message(message.messageID, buffer.getData())

      // 'Copy' the metadata
      completeMessage.metadata = message.metadata

      // We're no longer an offset packet
      completeMessage.metadata.offset = null

      // Clean up after ourselves
      this.deleteBuffer(message.messageID)

      // Push the completed message up the pipeline
      return this.push(completeMessage)
    }

    // We have dealt with the message
    return Promise.resolve()
  }
}
