import * as chai from 'chai'
import * as sinon from 'sinon'

import { CancellationToken, Message, Sink, Source } from '@electricui/core'
import { MESSAGEIDS, TYPES } from '@electricui/protocol-binary-constants'
import { describe, it, xit } from '@jest/globals'

import BinaryLargePacketHandlerEncoder from '../src/encoder'

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
  const encoder = new BinaryLargePacketHandlerEncoder({
    maxPayloadLength: 120,
  })
  const sink = new TestSink(spy)

  source.pipe(encoder).pipe(sink)

  return {
    source,
    sink,
    spy,
  }
}

describe('BinaryLargePacketHandlerEncoder', () => {
  it('short packets pass through without modification', () => {
    const { source, sink, spy } = setupPipeline()

    const message = new Message('abc', Buffer.from([42]))
    message.metadata.type = TYPES.CUSTOM_MARKER

    source.push(message, new CancellationToken())

    assert.deepEqual(spy.getCall(0).args[0], message)
  })
  it('splits a large packet up into smaller packets', () => {
    const { source, sink, spy } = setupPipeline()

    const messageID = 'abc'
    const type = TYPES.CUSTOM_MARKER

    // Begin the large packet transfer
    const largeMessage = new Message(
      messageID,
      Buffer.from(Object.keys(Array(401).join('\u0000')).map(i => parseInt(i, 10))),
    )
    largeMessage.metadata.type = type

    source.push(largeMessage, new CancellationToken())

    assert.deepEqual(spy.callCount, 5)
  })
  xit('requeues the packets it creates', () => {})
  xit('load balances the packets over multiple links', () => {})
  xit('checks for deliverability for the packets it creates', () => {})
  xit("resends parts of packets if they don't make it", () => {})
})
