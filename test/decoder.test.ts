import * as chai from 'chai'
import * as sinon from 'sinon'

import { ConnectionInterface, Message, Sink, Source } from '@electricui/core'
import { MESSAGEIDS, TYPES } from '@electricui/protocol-binary-constants'
import { describe, it } from '@jest/globals'
import { CancellationToken } from '@electricui/async-utilities'

import BinaryLargePacketHandlerDecoder from '../src/decoder'

const assert = chai.assert

class TestSink extends Sink {
  callback: (chunk: any) => void
  constructor(callback: (chunk: any) => void) {
    super()
    this.callback = callback
  }

  async receive(chunk: any) {
    return this.callback(chunk)
  }
}

function setupPipeline(writeCallback: (message: Message) => Promise<any> = async () => {}) {
  const spy = sinon.spy()
  const connectionInterfaceWriteSpy = sinon.spy()
  const connectionInterface = new ConnectionInterface()

  const source = new Source()
  const decoder = new BinaryLargePacketHandlerDecoder({
    loopTime: 1,
    connectionInterface,
    externalTiming: true, // we take over timing
  })
  const sink = new TestSink(spy)

  // override the connectionInterface write function
  connectionInterface.write = (message: Message) => {
    connectionInterfaceWriteSpy(message)
    return writeCallback(message)
  }

  source.pipe(decoder).pipe(sink)

  return {
    source,
    sink,
    spy,
    connectionInterface,
    connectionInterfaceWriteSpy,
    decoder,
  }
}

function makeOffsetPacketPartMessage(messageID: string, type: TYPES, offset: number, payload: Buffer) {
  const message = new Message(messageID, payload)
  message.metadata.type = type
  message.metadata.offset = offset

  return message
}

function getOffsetStartBuffer(start: number, end: number) {
  const payload = Buffer.allocUnsafe(4)
  payload.writeUInt16LE(start, 0)
  payload.writeUInt16LE(end, 2)

  return payload
}

function shuffle<T>(arr: Array<T>) {
  let input = arr

  for (let i = input.length - 1; i >= 0; i--) {
    let randomIndex = Math.floor(Math.random() * (i + 1))
    let itemAtIndex = input[randomIndex]

    input[randomIndex] = input[i]
    input[i] = itemAtIndex
  }

  return input
}

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

function* splitMessageIntoPieces(message: Message, maxPacketSize: number) {
  for (const splitPacket of splitBigPacket(message.payload, maxPacketSize)) {
    const newPacket = new Message(message.messageID, splitPacket.payload)
    newPacket.metadata = Object.assign({}, message.metadata) // copy all metadata
    newPacket.metadata.offset = splitPacket.offset

    yield newPacket
  }
}

describe('BinaryLargePacketHandlerDecoder', () => {
  it('non-offset packets pass through without modification', async () => {
    const { source, sink, spy } = setupPipeline()

    const message = new Message('abc', Buffer.from([42]))
    message.metadata.type = TYPES.CUSTOM_MARKER

    await source.push(message, new CancellationToken())

    assert.deepEqual(spy.getCall(0).args[0], message)
  })
  it('an offset packet is reconstructed properly when sent in reverse order', async () => {
    const { source, sink, spy } = setupPipeline()

    const messageID = 'abc'
    const type = TYPES.CUSTOM_MARKER
    const content = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09])

    // Begin the large packet transfer
    const begin = new Message(messageID, getOffsetStartBuffer(0, 10))
    begin.metadata.type = TYPES.OFFSET_METADATA

    await source.push(begin, new CancellationToken())

    // Generate the messages, write them in reverse order
    const bigMessage = new Message(messageID, content)
    bigMessage.metadata.type = type

    for (const part of Array.from(splitMessageIntoPieces(bigMessage, 1)).reverse()) {
      await source.push(part, new CancellationToken())
    }

    const receivedPacket = spy.getCall(0).args[0]
    assert.isTrue(content.equals(receivedPacket.payload))
  })
  it("an offset packet is reconstructed properly when sent in a 'forward' order", async () => {
    const { source, sink, spy } = setupPipeline()

    const messageID = 'abc'
    const type = TYPES.CUSTOM_MARKER
    const content = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09])

    // Begin the large packet transfer
    const begin = new Message(messageID, getOffsetStartBuffer(0, 10))
    begin.metadata.type = TYPES.OFFSET_METADATA

    await source.push(begin, new CancellationToken())

    // Generate the messages, write them in forward
    const bigMessage = new Message(messageID, content)
    bigMessage.metadata.type = type

    for (const part of splitMessageIntoPieces(bigMessage, 1)) {
      await source.push(part, new CancellationToken())
    }

    const receivedPacket = spy.getCall(0).args[0]
    assert.isTrue(content.equals(receivedPacket.payload))
  })
  it('an offset packet is reconstructed properly when sent in a random order', async () => {
    const { source, sink, spy } = setupPipeline()

    const messageID = 'abc'
    const type = TYPES.CUSTOM_MARKER
    const content = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09])

    // Begin the large packet transfer
    const begin = new Message(messageID, getOffsetStartBuffer(0, 10))
    begin.metadata.type = TYPES.OFFSET_METADATA

    await source.push(begin, new CancellationToken())

    // Generate the messages, write them in forward
    const bigMessage = new Message(messageID, content)
    bigMessage.metadata.type = type

    for (const part of shuffle(Array.from(splitMessageIntoPieces(bigMessage, 1)))) {
      await source.push(part, new CancellationToken())
    }

    const receivedPacket = spy.getCall(0).args[0]
    assert.isTrue(content.equals(receivedPacket.payload))
  })
  it('a huge offset packet is reconstructed properly when sent in a random order', async () => {
    const { source, sink, spy } = setupPipeline()

    const messageID = 'abc'
    const type = TYPES.CUSTOM_MARKER
    const content = Buffer.from(Object.keys(Array(401).join('\u0000')).map(i => parseInt(i, 10)))

    // Begin the large packet transfer
    const begin = new Message(messageID, getOffsetStartBuffer(0, content.length))
    begin.metadata.type = TYPES.OFFSET_METADATA

    await source.push(begin, new CancellationToken())

    // Generate the messages, write them in forward
    const bigMessage = new Message(messageID, content)
    bigMessage.metadata.type = type

    for (const part of shuffle(Array.from(splitMessageIntoPieces(bigMessage, Math.floor(Math.random() * 100))))) {
      await source.push(part, new CancellationToken())
    }

    const receivedPacket = spy.getCall(0).args[0]
    assert.isTrue(content.equals(receivedPacket.payload))
  })
  it("re-requests packets when they don't arrive on time", async () => {
    const writeCallback = async (message: Message) => {
      // console.log('received message in the write callback, ', message)
    }

    const { source, sink, spy, decoder, connectionInterfaceWriteSpy } = setupPipeline(writeCallback)

    const messageID = 'abc'
    const type = TYPES.CUSTOM_MARKER
    const content = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09])

    // Begin the large packet transfer
    const begin = new Message(messageID, getOffsetStartBuffer(0, content.length))
    begin.metadata.type = TYPES.OFFSET_METADATA

    decoder._getTime = () => 0

    await source.push(begin, new CancellationToken())

    // Generate the messages, write them in forward
    const bigMessage = new Message(messageID, content)
    bigMessage.metadata.type = type

    // Only send the even numbered parts
    for (const [index, part] of Array.from(splitMessageIntoPieces(bigMessage, 1)).entries()) {
      if (index % 2 === 0) {
        await source.push(part, new CancellationToken())
      }
      decoder.tick()
    }
    // advance the timer,
    decoder._getTime = () => 1000
    decoder.tick()

    // check that we have received requests for more data at the correct ranges
    connectionInterfaceWriteSpy.callCount = 5
    assert.deepEqual(connectionInterfaceWriteSpy.getCall(0).args[0].payload.start, 1) // prettier-ignore
    assert.deepEqual(connectionInterfaceWriteSpy.getCall(1).args[0].payload.start, 3) // prettier-ignore
    assert.deepEqual(connectionInterfaceWriteSpy.getCall(2).args[0].payload.start, 5) // prettier-ignore
    assert.deepEqual(connectionInterfaceWriteSpy.getCall(3).args[0].payload.start, 7) // prettier-ignore
    assert.deepEqual(connectionInterfaceWriteSpy.getCall(4).args[0].payload.start, 9) // prettier-ignore
    assert.deepEqual(connectionInterfaceWriteSpy.getCall(0).args[0].payload.end, 2) // prettier-ignore
    assert.deepEqual(connectionInterfaceWriteSpy.getCall(1).args[0].payload.end, 4) // prettier-ignore
    assert.deepEqual(connectionInterfaceWriteSpy.getCall(2).args[0].payload.end, 6) // prettier-ignore
    assert.deepEqual(connectionInterfaceWriteSpy.getCall(3).args[0].payload.end, 8) // prettier-ignore
    assert.deepEqual(connectionInterfaceWriteSpy.getCall(4).args[0].payload.end, 10) // prettier-ignore

    // Send the odd numbered parts
    for (const [index, part] of Array.from(splitMessageIntoPieces(bigMessage, 1)).entries()) {
      if (index % 2 === 1) {
        await source.push(part, new CancellationToken())
      }
    }

    const receivedPacket = spy.getCall(0).args[0]
    assert.isTrue(content.equals(receivedPacket.payload))
  })

  it('if a new bulk transfer comes through, the old one is wiped', async () => {
    const { source, sink, spy } = setupPipeline()

    const cancellationToken = new CancellationToken()

    const messageID = 'abc'
    const type = TYPES.CUSTOM_MARKER
    const content = Buffer.from(Object.keys(Array(401).join('\u0000')).map(i => parseInt(i, 10)))

    // Begin the large packet transfer
    const begin = new Message(messageID, getOffsetStartBuffer(0, content.length))
    begin.metadata.type = TYPES.OFFSET_METADATA

    await source.push(begin, cancellationToken)

    // Generate the messages, write them in forward
    const bigMessage = new Message(messageID, content)
    bigMessage.metadata.type = type

    // start sending the parts
    let counter = 0
    for (const part of splitMessageIntoPieces(bigMessage, 10)) {
      await source.push(part, cancellationToken)
      counter++

      // After 10, stop
      if (counter > 10) {
        break
      }
    }

    const content2 = Buffer.from(Object.keys(Array(200).join('\u0000')).map(i => parseInt(i, 10)))

    const bigMessage2 = new Message(messageID, content2)
    bigMessage2.metadata.type = type

    const begin2 = new Message(messageID, getOffsetStartBuffer(0, content2.length))
    begin2.metadata.type = TYPES.OFFSET_METADATA

    // start another large packet transfer
    await source.push(begin2, cancellationToken)

    // send it all again
    for (const part of splitMessageIntoPieces(bigMessage2, 10)) {
      await source.push(part, cancellationToken)
    }

    const receivedPacket = spy.getCall(0).args[0]
    assert.isTrue(content2.equals(receivedPacket.payload))
  })
})
