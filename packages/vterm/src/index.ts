export {
  createScreen as createVtermScreen,
  serializeSnapshot,
  type SerializeOptions,
  type Screen as VtermScreen,
  type ScreenOptions as VtermScreenOptions,
  // §9 canonical names
  type Snapshot,
  type Color,
  type Cursor,
  type ScreenAttrsSnapshot as VtermScreenAttrsSnapshot,
  type ScreenColorStateSnapshot as VtermScreenColorStateSnapshot,
  type ScreenParserState as VtermScreenParserState,
  type ScreenBufferSnapshot as VtermScreenBufferSnapshot,
  type ScreenCell,
  type UnderlineStyle,
  type SemanticZone,
  type SixelImage,
  type TerminalOp,
  type ParserEvent,
  type DirtyRegion,
  DEFAULT_MAX_STRING_SEQUENCE_LENGTH,
  // Reactive read plane (§4 signals facade)
  type ReadSignal,
  type ScreenSignals,
  type TerminalModes,
  type Size,
} from "./screen.ts"
export { decodeScreenSnapshotBinary, encodeScreenSnapshotBinary } from "./snapshot-codec.ts"
