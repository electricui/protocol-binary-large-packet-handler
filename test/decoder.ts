import 'mocha'

import * as chai from 'chai'
import * as sinon from 'sinon'

import { Message, Sink, Source } from '@electricui/core'
import { MESSAGEIDS, TYPES } from '@electricui/protocol-binary-constants'

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

function setupPipeline() {
  const spy = sinon.spy()

  const source = new Source()
  const encoder = new BinaryLargePacketHandlerDecoder({
    loopTime: 1,
  })
  const sink = new TestSink(spy)

  source.pipe(encoder).pipe(sink)

  return {
    source,
    sink,
    spy,
  }
}

function makeOffsetPacketPartMessage(
  messageID: string,
  type: TYPES,
  offset: number,
  payload: Buffer,
) {
  const message = new Message(messageID, payload)
  message.metadata.type = type
  message.metadata.offset = offset

  return message
}

describe('BinaryLargePacketHandlerDecoder', () => {
  it('non-offset packets pass through without modification', () => {
    const { source, sink, spy } = setupPipeline()

    const message = new Message('abc', Buffer.from([42]))
    message.metadata.type = TYPES.CUSTOM_MARKER

    source.push(message)

    assert.deepEqual(spy.getCall(0).args[0], message)
  })
  it('an offset packet is reconstructed properly when sent in reverse order', () => {
    const { source, sink, spy } = setupPipeline()

    const messageID = 'abc'
    const type = TYPES.CUSTOM_MARKER

    // Begin the large packet transfer
    const begin = new Message(
      messageID,
      Buffer.from(Uint16Array.from([0, 10]).buffer),
    )
    begin.metadata.type = TYPES.OFFSET_METADATA

    source.push(begin)

    // Generate all the parts
    const part0 = makeOffsetPacketPartMessage(messageID, type, 0, Buffer.from([0x00])) // prettier-ignore
    const part1 = makeOffsetPacketPartMessage(messageID, type, 1, Buffer.from([0x01])) // prettier-ignore
    const part2 = makeOffsetPacketPartMessage(messageID, type, 2, Buffer.from([0x02])) // prettier-ignore
    const part3 = makeOffsetPacketPartMessage(messageID, type, 3, Buffer.from([0x03])) // prettier-ignore
    const part4 = makeOffsetPacketPartMessage(messageID, type, 4, Buffer.from([0x04])) // prettier-ignore
    const part5 = makeOffsetPacketPartMessage(messageID, type, 5, Buffer.from([0x05])) // prettier-ignore
    const part6 = makeOffsetPacketPartMessage(messageID, type, 6, Buffer.from([0x06])) // prettier-ignore
    const part7 = makeOffsetPacketPartMessage(messageID, type, 7, Buffer.from([0x07])) // prettier-ignore
    const part8 = makeOffsetPacketPartMessage(messageID, type, 8, Buffer.from([0x08])) // prettier-ignore
    const part9 = makeOffsetPacketPartMessage(messageID, type, 9, Buffer.from([0x09])) // prettier-ignore

    // write them in reverse order
    source.push(part9)
    source.push(part8)
    source.push(part7)
    source.push(part6)
    source.push(part5)
    source.push(part4)
    source.push(part3)
    source.push(part2)
    source.push(part1)
    source.push(part0)

    const receivedPacket = spy.getCall(0).args[0]
    assert.isTrue(
      Buffer.from([
        0x00,
        0x01,
        0x02,
        0x03,
        0x04,
        0x05,
        0x06,
        0x07,
        0x08,
        0x09,
      ]).equals(receivedPacket.payload),
    )
  })
  it("an offset packet is reconstructed properly when sent in a 'forward' order", () => {
    const { source, sink, spy } = setupPipeline()

    const messageID = 'abc'
    const type = TYPES.CUSTOM_MARKER

    // Begin the large packet transfer
    const begin = new Message(
      messageID,
      Buffer.from(Uint16Array.from([0, 10]).buffer),
    )
    begin.metadata.type = TYPES.OFFSET_METADATA

    source.push(begin)

    // Generate all the parts
    const part0 = makeOffsetPacketPartMessage(messageID, type, 0, Buffer.from([0x00])) // prettier-ignore
    const part1 = makeOffsetPacketPartMessage(messageID, type, 1, Buffer.from([0x01])) // prettier-ignore
    const part2 = makeOffsetPacketPartMessage(messageID, type, 2, Buffer.from([0x02])) // prettier-ignore
    const part3 = makeOffsetPacketPartMessage(messageID, type, 3, Buffer.from([0x03])) // prettier-ignore
    const part4 = makeOffsetPacketPartMessage(messageID, type, 4, Buffer.from([0x04])) // prettier-ignore
    const part5 = makeOffsetPacketPartMessage(messageID, type, 5, Buffer.from([0x05])) // prettier-ignore
    const part6 = makeOffsetPacketPartMessage(messageID, type, 6, Buffer.from([0x06])) // prettier-ignore
    const part7 = makeOffsetPacketPartMessage(messageID, type, 7, Buffer.from([0x07])) // prettier-ignore
    const part8 = makeOffsetPacketPartMessage(messageID, type, 8, Buffer.from([0x08])) // prettier-ignore
    const part9 = makeOffsetPacketPartMessage(messageID, type, 9, Buffer.from([0x09])) // prettier-ignore

    // write them in forward order
    source.push(part0)
    source.push(part1)
    source.push(part2)
    source.push(part3)
    source.push(part4)
    source.push(part5)
    source.push(part6)
    source.push(part7)
    source.push(part8)
    source.push(part9)

    const receivedPacket = spy.getCall(0).args[0]
    assert.isTrue(
      Buffer.from([
        0x00,
        0x01,
        0x02,
        0x03,
        0x04,
        0x05,
        0x06,
        0x07,
        0x08,
        0x09,
      ]).equals(receivedPacket.payload),
    )
  })
})
