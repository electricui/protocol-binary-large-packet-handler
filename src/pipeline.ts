import { DuplexPipeline, Message, Pipeline, TypeCache } from '@electricui/core'
import { MESSAGEIDS, TYPES } from '@electricui/protocol-binary-constants'

import BinaryLargePacketHandlerDecoder, {
  BinaryLargePacketHandlerDecoderOptions,
} from '../src/decoder'
import BinaryLargePacketHandlerEncoder, {
  BinaryLargePacketHandlerEncoderOptions,
} from '../src/encoder'

/**
 * DeveloperNamespacePipelineSplitter splits Pipelines into Developer and Internal namespaces
 */
export class DeveloperNamespacePipelineSplitter extends Pipeline {
  internal: Pipeline
  developer: Pipeline

  constructor(internal: Pipeline, developer: Pipeline) {
    super()
    this.internal = internal
    this.developer = developer
  }

  receive(message: Message) {
    // If it's internal, pass it to the internal pipeline
    if (message.metadata.internal) {
      return this.internal.receive(message)
    }
    // otherwise pass it to the developer pipeline
    return this.developer.receive(message)
  }

  pipe(destination: Pipeline) {
    // We have to pipe our internal pipes to 'fan back in'
    this.internal.destination = destination
    this.developer.destination = destination
    return destination
  }
  onConnect() {
    this.internal.onConnect()
    this.developer.onConnect()
  }
  onConnecting() {
    this.internal.onConnecting()
    this.developer.onConnecting()
  }
  onDisconnect() {
    this.internal.onDisconnect()
    this.developer.onDisconnect()
  }
  onDisconnecting() {
    this.internal.onDisconnecting()
    this.developer.onDisconnecting()
  }
}

/**
 * The type cache duplex pipeline
 */
export default class BinaryLargePacketHandlerPipeline extends DuplexPipeline {
  readPipelineInternal: BinaryLargePacketHandlerDecoder
  readPipelineDeveloper: BinaryLargePacketHandlerDecoder
  writePipelineInternal: BinaryLargePacketHandlerEncoder
  writePipelineDeveloper: BinaryLargePacketHandlerEncoder

  readPipeline: DeveloperNamespacePipelineSplitter
  writePipeline: DeveloperNamespacePipelineSplitter

  constructor(
    options: BinaryLargePacketHandlerDecoderOptions &
      BinaryLargePacketHandlerEncoderOptions,
  ) {
    super()

    this.readPipelineInternal = new BinaryLargePacketHandlerDecoder(options)
    this.writePipelineInternal = new BinaryLargePacketHandlerEncoder(options)
    this.readPipelineDeveloper = new BinaryLargePacketHandlerDecoder(options)
    this.writePipelineDeveloper = new BinaryLargePacketHandlerEncoder(options)

    this.readPipeline = new DeveloperNamespacePipelineSplitter(
      this.readPipelineInternal,
      this.readPipelineDeveloper,
    )
    this.writePipeline = new DeveloperNamespacePipelineSplitter(
      this.writePipelineInternal,
      this.writePipelineDeveloper,
    )
  }
}
