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
  // §9 deprecated aliases (ride the migration window; @deprecated tags live on the declarations)
  type ScreenSnapshot,
  type CellColor,
  type ScreenSnapshot as VtermScreenSnapshot,
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
  // Reactive read plane (§4 signals facade)
  type ReadSignal,
  type ScreenSignals,
  type TerminalModes,
  type Size,
} from "./screen.ts"
export { decodeScreenSnapshotBinary, encodeScreenSnapshotBinary } from "./snapshot-codec.ts"
