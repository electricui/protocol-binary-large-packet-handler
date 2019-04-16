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
}

/**
 * The type cache duplex pipeline
 */
export default class BinaryTypeCachePipeline extends DuplexPipeline {
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
