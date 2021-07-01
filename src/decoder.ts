import { ConnectionInterface, Message, Pipeline } from '@electricui/core'
import { Interval, IntervalTree } from 'node-interval-tree'
import { CancellationToken } from '@electricui/async-utilities'

import { OffsetMetadataCodec } from '@electricui/protocol-binary-codecs'
import { TYPES } from '@electricui/protocol-binary-constants'

export interface BinaryLargePacketHandlerDecoderOptions {
  loopTime?: number
  fixedGraceTime?: number
  connectionInterface: ConnectionInterface
  externalTiming?: boolean
  hashFromMessage?: (message: Message) => string
}

const dDecoder = require('debug')('electricui-protocol-binary-large-packet-handler:decoder')

type getTimeFunc = () => number

class LargePacketInternalBuffer {
  private buffer: Buffer
  private receivedRanges = new IntervalTree()
  private getTime: getTimeFunc
  private timings: number[] = []
  private circularTimingsBuffer = 20 // Only sample the last 20 timings to avoid memory leaks

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
    this.getAverageTimeBetweenPackets = this.getAverageTimeBetweenPackets.bind(this)
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

    if (typeof firstTiming === 'undefined' || typeof lastTiming === 'undefined') {
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
  private loopTime: number
  private fixedGraceTime: number
  private metadataCodec = new OffsetMetadataCodec()
  private buffers: {
    [bufferHash: string]: LargePacketInternalBuffer
  } = {}
  private metadata: {
    [bufferHash: string]: any
  } = {}
  private messageIDs: {
    [bufferHash: string]: string
  } = {}
  private lastRequestBatchTime: {
    [bufferHash: string]: number
  } = {}
  private connectionInterface: ConnectionInterface
  private externalTiming: boolean
  private timer: NodeJS.Timer | null = null
  /**
   * Generate buckets of unique messages using this function.
   *
   * By default, just use the messageID.
   *
   * If using sequence numbers, set this to something that includes both the messageID
   * and the sequence number.
   */
  private hashFromMessage: (message: Message) => string

  constructor(options: BinaryLargePacketHandlerDecoderOptions) {
    super()
    this.loopTime = options.loopTime || 16
    this.fixedGraceTime = options.fixedGraceTime || 50
    this.connectionInterface = options.connectionInterface
    this.externalTiming = options.externalTiming || false
    this.hashFromMessage = options.hashFromMessage ? options.hashFromMessage : (message: Message) => message.messageID

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
    return Date.now()
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
    for (const bufferHash of Object.keys(this.buffers)) {
      const buffer = this.buffers[bufferHash]

      const averageTime = buffer.getAverageTimeBetweenPackets()

      if (averageTime === null) {
        continue
      }

      dDecoder(`Average time between packets for ${bufferHash} is ${averageTime}ms`)

      const lastTimeRequestedBatch = this.lastRequestBatchTime[bufferHash]

      // if the time between now and the last batch request is below our threshold, don't ask again
      if (now - lastTimeRequestedBatch < averageTime * 3 + this.fixedGraceTime) {
        continue
      }

      const progress = buffer.getProgress()
      const total = buffer.getTotal()
      const remaining = total - progress
      const lastTimeReceived = buffer.getLastTimeReceived()

      const expectedTimeToFinish = lastTimeReceived + (averageTime / progress) * remaining

      const cancellationToken = new CancellationToken()
      cancellationToken.deadline(averageTime * 3)

      // If we expect it to _be finished_ by now, request the remainder of the data again
      if (expectedTimeToFinish + this.fixedGraceTime < now) {
        for (const range of buffer.getRangesNotReceived()) {
          this.requestRange(bufferHash, range.low, range.high, cancellationToken)
        }

        // now is the last time we requested a batch
        this.lastRequestBatchTime[bufferHash] = this.getTime()
      }
    }
  }

  private allocateBuffer(message: Message, size: number) {
    const bufferHash = this.hashFromMessage(message)

    dDecoder(`Allocating a buffer for ${bufferHash} of size ${size} bytes`)
    this.buffers[bufferHash] = new LargePacketInternalBuffer(size, this.getTime)

    dDecoder(`Recording metadata for ${bufferHash}`)
    this.metadata[bufferHash] = Object.assign({}, message.metadata)

    // Setup when we last requested the batch. It was 'roughly now'
    this.lastRequestBatchTime[bufferHash] = this.getTime()

    // Setup the messageID of this bufferHash
    this.messageIDs[bufferHash] = message.messageID
  }

  private deleteBuffer(bufferHash: string) {
    delete this.buffers[bufferHash]
    delete this.metadata[bufferHash]
    delete this.lastRequestBatchTime[bufferHash]
    delete this.messageIDs[bufferHash]
  }

  private getBuffer(bufferHash: string) {
    return this.buffers[bufferHash] || null
  }

  private hasBuffer(bufferHash: string) {
    return this.getBuffer(bufferHash) !== null
  }

  private processOffsetMetadataPacket(message: Message) {
    const bufferHash = this.hashFromMessage(message)

    dDecoder('Decoded an offset metadata message', bufferHash, message.payload)
    if (this.hasBuffer(bufferHash)) {
      console.error(`Received an offset metadata message for a bufferHash, ${bufferHash} that already has a buffer.`)
      return Promise.resolve()
    }

    // Allocate a buffer that is the size of the message
    const size = message.payload.end - message.payload.start

    this.allocateBuffer(message, size)

    return Promise.resolve()
  }

  private requestRange(bufferHash: string, start: number, end: number, cancellationToken: CancellationToken) {
    dDecoder('Requesting the range of', bufferHash, 'from', start, 'to', end)

    // TODO: get the messageID of this bufferHash
    const messageID = this.messageIDs[bufferHash]

    if (!messageID) {
      console.error(`Couldn't find the messageID for bufferHash ${bufferHash}.`)
      return Promise.resolve()
    }

    // The message is encoded by the codecs pipeline since it's passed back up through the entire connectionInterface
    const message = new Message(messageID, {
      start,
      end,
    })

    message.metadata = Object.assign({}, this.metadata[bufferHash], {
      query: true,
      offset: null,
      type: TYPES.OFFSET_METADATA,
      ack: false, // TODO: Ack this and deal with it in a more clever manner
      ackNum: 0,
    })

    return this.connectionInterface.write(message, cancellationToken)
  }

  receive(message: Message, cancellationToken: CancellationToken) {
    // Null payloads go immediately
    if (message.payload === null) {
      return this.push(message, cancellationToken)
    }

    const bufferHash = this.hashFromMessage(message)

    // if it's a offset metadata packet, allocate the space for it
    if (message.metadata.type === TYPES.OFFSET_METADATA) {
      // Decode the packet, then call our processOffsetMetadataPacket function with the message, passing the promise through the chain.

      dDecoder('received the start of an offset data transfer', bufferHash)

      message.payload = this.metadataCodec.decode(message.payload)

      // This doesn't happen automatically because of the ordering of the codec pipeline versus this pipeline
      return this.processOffsetMetadataPacket(message)
    }

    // If the packet has no offset, push it on
    if (message.metadata.offset === null) {
      // dDecoder('encountered a packet with no offset')
      return this.push(message, cancellationToken)
    }

    // If the packet is a callback, push it on, this should never happen.
    if (message.metadata.type === TYPES.CALLBACK) {
      dDecoder('encountered a non-null callback packet?', message)
      return this.push(message, cancellationToken)
    }

    // it's an offset packet

    // if we haven't allocated a buffer yet, error
    if (!this.hasBuffer(bufferHash)) {
      console.error(`Received an offset packet for messageID, ${bufferHash} that doesn't have a buffer allocated.`)

      return Promise.reject()
    }

    // we have a packet, and a buffer allocated, place it in the buffer
    const buffer = this.getBuffer(bufferHash)

    buffer.addData(message.metadata.offset, message.payload)

    // check progress
    const progress = buffer.getProgress()
    const total = buffer.getTotal()

    // TODO: send a progress update

    // if it's complete, send the full packet
    if (progress === total) {
      dDecoder(`completed a packet for ${bufferHash} which took ${buffer.getDurationOfTransfer()}ms`)

      const messageID = this.messageIDs[bufferHash]

      if (!messageID) {
        console.error(`Couldn't find the messageID for bufferHash ${bufferHash}.`)
        return Promise.reject()
      }

      // Create a new message
      const completeMessage = new Message(messageID, buffer.getData())

      // Copy the metadata
      completeMessage.metadata = Object.assign({}, message.metadata)

      // We're no longer an offset packet
      completeMessage.metadata.offset = null

      // Clean up after ourselves
      this.deleteBuffer(bufferHash)

      // Push the completed message up the pipeline
      return this.push(completeMessage, cancellationToken)
    }

    // We have dealt with the message
    return Promise.resolve()
  }
}
