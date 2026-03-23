/**
 * TypeScript wrapper for libghostty-vt WASM API
 *
 * High-performance terminal emulation using Ghostty's battle-tested VT100 parser.
 * The key optimization is the RenderState API which provides a pre-computed
 * snapshot of all render data in a single update call.
 */

import {
  CellFlags,
  type Cursor,
  DirtyState,
  GHOSTTY_CONFIG_SIZE,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  type GhosttyWasmExports,
  KeyEncoderOption,
  type KeyEvent,
  type KittyKeyFlags,
  type RGB,
  type RenderStateColors,
  type RenderStateCursor,
  type RenderStateHandle,
  type RenderStateRowCellsHandle,
  type RenderStateRowIteratorHandle,
  type TerminalHandle,
} from './types';

// Re-export types for convenience
export {
  CellFlags,
  type Cursor,
  DirtyState,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  KeyEncoderOption,
  type RGB,
  type RenderStateColors,
  type RenderStateCursor,
};

const TERMINAL_OPTIONS_SIZE = 8;
const TERMINAL_SCROLLBAR_SIZE = 24;
const POINT_SIZE = 24;
const GRID_REF_SIZE = 12;
const STYLE_SIZE = 72;

const POINT_TAG_HISTORY = 3;

const TERMINAL_DATA_ACTIVE_SCREEN = 6;
const TERMINAL_DATA_SCROLLBAR = 9;
const TERMINAL_DATA_MOUSE_TRACKING = 11;

const RENDER_STATE_DATA_DIRTY = 3;
const RENDER_STATE_DATA_ROW_ITERATOR = 4;
const RENDER_STATE_DATA_COLOR_BACKGROUND = 5;
const RENDER_STATE_DATA_COLOR_FOREGROUND = 6;
const RENDER_STATE_DATA_CURSOR_VISUAL_STYLE = 10;
const RENDER_STATE_DATA_CURSOR_VISIBLE = 11;
const RENDER_STATE_DATA_CURSOR_BLINKING = 12;
const RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE = 14;
const RENDER_STATE_DATA_CURSOR_VIEWPORT_X = 15;
const RENDER_STATE_DATA_CURSOR_VIEWPORT_Y = 16;

const RENDER_STATE_OPTION_DIRTY = 0;

const RENDER_STATE_ROW_DATA_DIRTY = 1;
const RENDER_STATE_ROW_DATA_CELLS = 3;
const RENDER_STATE_ROW_OPTION_DIRTY = 0;

const RENDER_STATE_ROW_CELLS_DATA_RAW = 1;
const RENDER_STATE_ROW_CELLS_DATA_STYLE = 2;
const RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN = 3;
const RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF = 4;
const RENDER_STATE_ROW_CELLS_DATA_BG_COLOR = 5;
const RENDER_STATE_ROW_CELLS_DATA_FG_COLOR = 6;

const CELL_DATA_CODEPOINT = 1;
const CELL_DATA_WIDE = 3;
const CELL_DATA_HAS_HYPERLINK = 7;

const ROW_DATA_WRAP_CONTINUATION = 2;

const WIDE_NARROW = 0;
const WIDE_WIDE = 1;
const WIDE_SPACER_TAIL = 2;
const WIDE_SPACER_HEAD = 3;

/**
 * Stable render snapshot captured from libghostty render state.
 *
 * This is intentionally closer to Ghostling/libghostty's model than the older
 * "live terminal as renderable" approach: update render state once, snapshot it,
 * and render from that immutable frame without re-entering the terminal.
 */
export class GhosttyRenderFrame {
  private readonly terminal: GhosttyTerminal;
  private readonly lines: GhosttyCell[][];
  private readonly rowDirty: boolean[];
  private readonly cursor: { x: number; y: number; visible: boolean };
  private readonly dimensions: { cols: number; rows: number };
  private readonly fullRedraw: boolean;
  private dirtyCleared = false;

  constructor(args: {
    terminal: GhosttyTerminal;
    lines: GhosttyCell[][];
    rowDirty: boolean[];
    cursor: { x: number; y: number; visible: boolean };
    dimensions: { cols: number; rows: number };
    fullRedraw: boolean;
  }) {
    this.terminal = args.terminal;
    this.lines = args.lines;
    this.rowDirty = args.rowDirty;
    this.cursor = args.cursor;
    this.dimensions = args.dimensions;
    this.fullRedraw = args.fullRedraw;
  }

  getLine(y: number): GhosttyCell[] | null {
    if (y < 0 || y >= this.lines.length) return null;
    return this.lines[y];
  }

  getCursor(): { x: number; y: number; visible: boolean } {
    return this.cursor;
  }

  getDimensions(): { cols: number; rows: number } {
    return this.dimensions;
  }

  isRowDirty(y: number): boolean {
    if (y < 0 || y >= this.rowDirty.length) return false;
    return this.rowDirty[y];
  }

  needsFullRedraw(): boolean {
    return this.fullRedraw;
  }

  clearDirty(): void {
    if (this.dirtyCleared) return;
    this.dirtyCleared = true;
    this.terminal.markClean();
  }

  getGraphemeString(row: number, col: number): string {
    const cell = this.getCell(row, col);
    if (!cell) return ' ';
    return cell.grapheme ?? String.fromCodePoint(cell.codepoint || 32);
  }

  getViewport(): readonly GhosttyCell[][] {
    return this.lines;
  }

  getCell(row: number, col: number): GhosttyCell | null {
    const line = this.getLine(row);
    if (!line || col < 0 || col >= line.length) return null;
    return line[col];
  }
}

/**
 * Main Ghostty WASM wrapper class
 */
export class Ghostty {
  private exports: GhosttyWasmExports;
  private memory: WebAssembly.Memory;

  constructor(wasmInstance: WebAssembly.Instance) {
    this.exports = wasmInstance.exports as GhosttyWasmExports;
    this.memory = this.exports.memory;
  }

  createKeyEncoder(): KeyEncoder {
    return new KeyEncoder(this.exports);
  }

  createTerminal(
    cols: number = 80,
    rows: number = 24,
    config?: GhosttyTerminalConfig
  ): GhosttyTerminal {
    return new GhosttyTerminal(this.exports, this.memory, cols, rows, config);
  }

  static async load(wasmPath?: string): Promise<Ghostty> {
    // If explicit path provided, use it
    if (wasmPath) {
      return Ghostty.loadFromPath(wasmPath);
    }

    // Resolve path relative to this module
    const moduleUrl = new URL('../ghostty-vt.wasm', import.meta.url);

    // Build paths to try, prioritizing file system paths for Node/Bun
    const defaultPaths: string[] = [];

    // For Node/Bun: try absolute file path first (strip file:// protocol)
    if (moduleUrl.protocol === 'file:') {
      let filePath = moduleUrl.pathname;
      // Remove leading slash on Windows paths (e.g., /C:/ -> C:/)
      if (filePath.match(/^\/[A-Za-z]:\//)) {
        filePath = filePath.slice(1);
      }
      defaultPaths.push(filePath);
    }

    // Also try other common paths
    defaultPaths.push(moduleUrl.href, './ghostty-vt.wasm', '/ghostty-vt.wasm');

    let lastError: Error | null = null;
    for (const path of defaultPaths) {
      try {
        return await Ghostty.loadFromPath(path);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw lastError || new Error('Failed to load Ghostty WASM');
  }

  private static async loadFromPath(path: string): Promise<Ghostty> {
    let wasmBytes: ArrayBuffer | undefined;

    // Try Bun.file first (for Bun environments)
    if (typeof Bun !== 'undefined' && typeof Bun.file === 'function') {
      try {
        const file = Bun.file(path);
        if (await file.exists()) {
          wasmBytes = await file.arrayBuffer();
        }
      } catch {
        // Bun.file failed, try next method
      }
    }

    // Try Node.js fs module if Bun.file didn't work
    if (!wasmBytes) {
      try {
        const fs = await import('fs/promises');
        const buffer = await fs.readFile(path);
        wasmBytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      } catch {
        // fs failed, try fetch
      }
    }

    // Fall back to fetch (for browser environments)
    if (!wasmBytes) {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`Failed to fetch WASM: ${response.status} ${response.statusText}`);
      }
      wasmBytes = await response.arrayBuffer();
      if (wasmBytes.byteLength === 0) {
        throw new Error(`WASM file is empty (0 bytes). Check path: ${path}`);
      }
    }

    if (!wasmBytes) {
      throw new Error(`Could not load WASM from path: ${path}`);
    }

    const wasmModule = await WebAssembly.compile(wasmBytes);
    const wasmInstance = await WebAssembly.instantiate(wasmModule, {
      env: {
        log: (ptr: number, len: number) => {
          const bytes = new Uint8Array(
            (wasmInstance.exports as GhosttyWasmExports).memory.buffer,
            ptr,
            len
          );
          console.log('[ghostty-vt]', new TextDecoder().decode(bytes));
        },
      },
    });
    return new Ghostty(wasmInstance);
  }
}

/**
 * Key Encoder - converts keyboard events into terminal escape sequences
 */
export class KeyEncoder {
  private exports: GhosttyWasmExports;
  private encoder: number = 0;

  constructor(exports: GhosttyWasmExports) {
    this.exports = exports;
    const encoderPtrPtr = this.exports.ghostty_wasm_alloc_opaque();
    const result = this.exports.ghostty_key_encoder_new(0, encoderPtrPtr);
    if (result !== 0) throw new Error(`Failed to create key encoder: ${result}`);
    const view = new DataView(this.exports.memory.buffer);
    this.encoder = view.getUint32(encoderPtrPtr, true);
    this.exports.ghostty_wasm_free_opaque(encoderPtrPtr);
  }

  setOption(option: KeyEncoderOption, value: boolean | number): void {
    const valuePtr = this.exports.ghostty_wasm_alloc_u8();
    const view = new DataView(this.exports.memory.buffer);
    view.setUint8(valuePtr, typeof value === 'boolean' ? (value ? 1 : 0) : value);
    this.exports.ghostty_key_encoder_setopt(this.encoder, option, valuePtr);
    this.exports.ghostty_wasm_free_u8(valuePtr);
  }

  setKittyFlags(flags: KittyKeyFlags): void {
    this.setOption(KeyEncoderOption.KITTY_KEYBOARD_FLAGS, flags);
  }

  encode(event: KeyEvent): Uint8Array {
    const eventPtrPtr = this.exports.ghostty_wasm_alloc_opaque();
    const createResult = this.exports.ghostty_key_event_new(0, eventPtrPtr);
    if (createResult !== 0) throw new Error(`Failed to create key event: ${createResult}`);

    const view = new DataView(this.exports.memory.buffer);
    const eventPtr = view.getUint32(eventPtrPtr, true);
    this.exports.ghostty_wasm_free_opaque(eventPtrPtr);

    this.exports.ghostty_key_event_set_action(eventPtr, event.action);
    this.exports.ghostty_key_event_set_key(eventPtr, event.key);
    this.exports.ghostty_key_event_set_mods(eventPtr, event.mods);

    if (event.utf8) {
      const encoder = new TextEncoder();
      const utf8Bytes = encoder.encode(event.utf8);
      const utf8Ptr = this.exports.ghostty_wasm_alloc_u8_array(utf8Bytes.length);
      new Uint8Array(this.exports.memory.buffer).set(utf8Bytes, utf8Ptr);
      this.exports.ghostty_key_event_set_utf8(eventPtr, utf8Ptr, utf8Bytes.length);
      this.exports.ghostty_wasm_free_u8_array(utf8Ptr, utf8Bytes.length);
    }

    const bufferSize = 32;
    const bufPtr = this.exports.ghostty_wasm_alloc_u8_array(bufferSize);
    const writtenPtr = this.exports.ghostty_wasm_alloc_usize();

    const encodeResult = this.exports.ghostty_key_encoder_encode(
      this.encoder,
      eventPtr,
      bufPtr,
      bufferSize,
      writtenPtr
    );

    if (encodeResult !== 0) {
      this.exports.ghostty_wasm_free_u8_array(bufPtr, bufferSize);
      this.exports.ghostty_wasm_free_usize(writtenPtr);
      this.exports.ghostty_key_event_free(eventPtr);
      throw new Error(`Failed to encode key: ${encodeResult}`);
    }

    const bytesWritten = view.getUint32(writtenPtr, true);
    const encoded = new Uint8Array(this.exports.memory.buffer, bufPtr, bytesWritten).slice();

    this.exports.ghostty_wasm_free_u8_array(bufPtr, bufferSize);
    this.exports.ghostty_wasm_free_usize(writtenPtr);
    this.exports.ghostty_key_event_free(eventPtr);

    return encoded;
  }

  dispose(): void {
    if (this.encoder) {
      this.exports.ghostty_key_encoder_free(this.encoder);
      this.encoder = 0;
    }
  }
}

/**
 * GhosttyTerminal - High-performance terminal emulator
 *
 * Uses Ghostty's native RenderState for optimal performance:
 * - ONE call to update all state (renderStateUpdate)
 * - ONE call to get all cells (getViewport)
 * - No per-row WASM boundary crossings!
 */
export class GhosttyTerminal {
  private exports: GhosttyWasmExports;
  private memory: WebAssembly.Memory;
  private handle: TerminalHandle;
  private renderStateHandle: RenderStateHandle;
  private rowIteratorHandle: RenderStateRowIteratorHandle;
  private rowCellsHandle: RenderStateRowCellsHandle;
  private lastAlternateScreen: boolean;
  private _cols: number;
  private _rows: number;

  /** Size of GhosttyCell in WASM (16 bytes) */
  private static readonly CELL_SIZE = 16;

  /** Cell pool for zero-allocation rendering */
  private cellPool: GhosttyCell[] = [];
  private scratchPtr: number = 0;
  private styleBufferPtr: number = 0;
  private renderColorsBufferPtr: number = 0;
  private pointBufferPtr: number = 0;
  private gridRefBufferPtr: number = 0;
  private rowBufferPtr: number = 0;
  private cellBufferPtr: number = 0;

  constructor(
    exports: GhosttyWasmExports,
    memory: WebAssembly.Memory,
    cols: number = 80,
    rows: number = 24,
    config?: GhosttyTerminalConfig
  ) {
    this.exports = exports;
    this.memory = memory;
    this._cols = cols;
    this._rows = rows;

    if (config) {
      // Allocate config struct in WASM memory
      const configPtr = this.exports.ghostty_wasm_alloc_u8_array(GHOSTTY_CONFIG_SIZE);
      if (configPtr === 0) {
        throw new Error('Failed to allocate config (out of memory)');
      }

      try {
        // Write config to WASM memory
        const view = new DataView(this.memory.buffer);
        let offset = configPtr;

        // scrollback_limit (u32)
        view.setUint32(offset, config.scrollbackLimit ?? 10000, true);
        offset += 4;

        // fg_color (u32)
        view.setUint32(offset, config.fgColor ?? 0, true);
        offset += 4;

        // bg_color (u32)
        view.setUint32(offset, config.bgColor ?? 0, true);
        offset += 4;

        // cursor_color (u32)
        view.setUint32(offset, config.cursorColor ?? 0, true);
        offset += 4;

        // palette[16] (u32 * 16)
        for (let i = 0; i < 16; i++) {
          view.setUint32(offset, config.palette?.[i] ?? 0, true);
          offset += 4;
        }

        const createWithConfig = this.exports.ghostty_terminal_new_with_config;
        if (!createWithConfig) {
          throw new Error('ghostty_terminal_new_with_config is not available in this WASM build');
        }

        this.handle = createWithConfig(cols, rows, configPtr);
      } finally {
        // Free the config memory
        this.exports.ghostty_wasm_free_u8_array(configPtr, GHOSTTY_CONFIG_SIZE);
      }
    } else {
      const optionsPtr = this.exports.ghostty_wasm_alloc_u8_array(TERMINAL_OPTIONS_SIZE);
      if (optionsPtr === 0) {
        throw new Error('Failed to allocate terminal options (out of memory)');
      }

      try {
        const view = new DataView(this.memory.buffer);
        view.setUint16(optionsPtr + 0, cols, true);
        view.setUint16(optionsPtr + 2, rows, true);
        view.setUint32(optionsPtr + 4, 10000, true);

        const resultPtr = this.exports.ghostty_wasm_alloc_opaque();
        try {
          const result = this.exports.ghostty_terminal_new(0, resultPtr, optionsPtr);
          if (result !== 0) {
            throw new Error(`Failed to create terminal: ${result}`);
          }
          this.handle = new DataView(this.memory.buffer).getUint32(resultPtr, true);
        } finally {
          this.exports.ghostty_wasm_free_opaque(resultPtr);
        }
      } finally {
        this.exports.ghostty_wasm_free_u8_array(optionsPtr, TERMINAL_OPTIONS_SIZE);
      }
    }

    if (!this.handle) throw new Error('Failed to create terminal');
    this.renderStateHandle = this.createRenderState();
    this.rowIteratorHandle = this.createRowIterator();
    this.rowCellsHandle = this.createRowCells();
    this.allocBuffers();
    this.lastAlternateScreen = this.isAlternateScreen();

    this.initCellPool();
  }

  get cols(): number {
    return this._cols;
  }
  get rows(): number {
    return this._rows;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  write(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const ptr = this.exports.ghostty_wasm_alloc_u8_array(bytes.length);
    new Uint8Array(this.memory.buffer).set(bytes, ptr);
    if (this.exports.ghostty_terminal_write) {
      this.exports.ghostty_terminal_write(this.handle, ptr, bytes.length);
    } else {
      this.exports.ghostty_terminal_vt_write(this.handle, ptr, bytes.length);
    }
    this.exports.ghostty_wasm_free_u8_array(ptr, bytes.length);
  }

  resize(cols: number, rows: number): void {
    if (cols === this._cols && rows === this._rows) return;
    this._cols = cols;
    this._rows = rows;
    const result = this.exports.ghostty_terminal_resize(this.handle, cols, rows);
    if (result !== 0) {
      throw new Error(`Failed to resize terminal: ${result}`);
    }
    this.invalidateBuffers();
    this.initCellPool();
  }

  free(): void {
    if (this.graphemeBufferPtr) {
      this.exports.ghostty_wasm_free_u8_array(this.graphemeBufferPtr, 16 * 4);
      this.graphemeBufferPtr = 0;
      this.graphemeBuffer = null;
    }
    if (this.rowCellsHandle) {
      this.exports.ghostty_render_state_row_cells_free(this.rowCellsHandle);
      this.rowCellsHandle = 0;
    }
    if (this.rowIteratorHandle) {
      this.exports.ghostty_render_state_row_iterator_free(this.rowIteratorHandle);
      this.rowIteratorHandle = 0;
    }
    if (this.scratchPtr) {
      this.exports.ghostty_wasm_free_u8_array(this.scratchPtr, 1024);
      this.scratchPtr = 0;
    }
    if (this.styleBufferPtr) {
      this.exports.ghostty_wasm_free_u8_array(this.styleBufferPtr, STYLE_SIZE);
      this.styleBufferPtr = 0;
    }
    if (this.renderColorsBufferPtr) {
      this.exports.ghostty_wasm_free_u8_array(this.renderColorsBufferPtr, 792);
      this.renderColorsBufferPtr = 0;
    }
    if (this.pointBufferPtr) {
      this.exports.ghostty_wasm_free_u8_array(this.pointBufferPtr, POINT_SIZE);
      this.pointBufferPtr = 0;
    }
    if (this.gridRefBufferPtr) {
      this.exports.ghostty_wasm_free_u8_array(this.gridRefBufferPtr, GRID_REF_SIZE);
      this.gridRefBufferPtr = 0;
    }
    if (this.rowBufferPtr) {
      this.exports.ghostty_wasm_free_u8_array(this.rowBufferPtr, 8);
      this.rowBufferPtr = 0;
    }
    if (this.cellBufferPtr) {
      this.exports.ghostty_wasm_free_u8_array(this.cellBufferPtr, 8);
      this.cellBufferPtr = 0;
    }
    this.exports.ghostty_render_state_free(this.renderStateHandle);
    this.exports.ghostty_terminal_free(this.handle);
  }

  // ==========================================================================
  // RenderState API - The key performance optimization
  // ==========================================================================

  /**
   * Update render state from terminal.
   *
   * This syncs the RenderState with the current Terminal state.
   * The dirty state (full/partial/none) is stored in the WASM RenderState
   * and can be queried via isRowDirty(). When dirty==full, isRowDirty()
   * returns true for ALL rows.
   *
   * The WASM layer automatically detects screen switches (normal <-> alternate)
   * and returns FULL dirty state when switching screens (e.g., vim exit).
   *
   * Safe to call multiple times - dirty state persists until markClean().
   */
  update(): DirtyState {
    const currentAlternateScreen = this.isAlternateScreen();
    if (currentAlternateScreen !== this.lastAlternateScreen) {
      this.exports.ghostty_render_state_free(this.renderStateHandle);
      this.renderStateHandle = this.createRenderState();
      this.lastAlternateScreen = currentAlternateScreen;
    }

    const result = this.exports.ghostty_render_state_update(this.renderStateHandle, this.handle);
    if (result !== 0) {
      return DirtyState.FULL;
    }
    return this.getRenderStateDirty();
  }

  /**
   * Get cursor state from render state.
   * Ensures render state is fresh by calling update().
   */
  getCursor(): RenderStateCursor {
    this.update();
    return this.getCursorFromCurrentRenderState();
  }

  /**
   * Get default colors from render state
   */
  getColors(): RenderStateColors {
    return {
      background: this.getRenderStateColor(RENDER_STATE_DATA_COLOR_BACKGROUND),
      foreground: this.getRenderStateColor(RENDER_STATE_DATA_COLOR_FOREGROUND),
      cursor: null, // TODO: Add cursor color support
    };
  }

  /**
   * Check if a specific row is dirty
   */
  isRowDirty(y: number): boolean {
    if (y < 0 || y >= this._rows) return false;
    const dirty = this.getRenderStateDirty();
    if (dirty === DirtyState.FULL) return true;
    if (dirty === DirtyState.NONE) return false;
    this.prepareRowIterator();
    for (let row = 0; row <= y; row++) {
      if (!this.exports.ghostty_render_state_row_iterator_next(this.rowIteratorHandle)) {
        return false;
      }
    }
    this.requireSuccess(
      this.exports.ghostty_render_state_row_get(
        this.rowIteratorHandle,
        RENDER_STATE_ROW_DATA_DIRTY,
        this.scratchPtr
      ),
      'read row dirty state'
    );
    return this.readBool(this.scratchPtr);
  }

  /**
   * Mark render state as clean (call after rendering)
   */
  markClean(): void {
    this.writeU32(this.scratchPtr, DirtyState.NONE);
    this.requireSuccess(
      this.exports.ghostty_render_state_set(
        this.renderStateHandle,
        RENDER_STATE_OPTION_DIRTY,
        this.scratchPtr
      ),
      'clear render-state dirty flag'
    );

    this.prepareRowIterator();
    this.writeBool(this.scratchPtr, false);
    while (this.exports.ghostty_render_state_row_iterator_next(this.rowIteratorHandle)) {
      this.requireSuccess(
        this.exports.ghostty_render_state_row_set(
          this.rowIteratorHandle,
          RENDER_STATE_ROW_OPTION_DIRTY,
          this.scratchPtr
        ),
        'clear row dirty flag'
      );
    }
  }

  /**
   * Get ALL viewport cells in ONE WASM call - the key performance optimization!
   * Returns a reusable cell array (zero allocation after warmup).
   */
  getViewport(): GhosttyCell[] {
    this.update();
    return this.getViewportFromCurrentRenderState();
  }

  /**
   * Capture a stable render frame from the current render state.
   *
   * This is the preferred render primitive for consumers. It follows the
   * same shape as libghostty/Ghostling: update once, snapshot, then render
   * from the snapshot without re-entering terminal state during paint.
   */
  createRenderFrame(): GhosttyRenderFrame {
    const dirty = this.update();
    const cursor = this.getCursorFromCurrentRenderState();
    const viewport = this.getViewportFromCurrentRenderState();
    const lines: GhosttyCell[][] = [];
    const rowDirty: boolean[] = [];

    for (let y = 0; y < this._rows; y++) {
      const start = y * this._cols;
      lines.push(viewport.slice(start, start + this._cols).map((cell) => ({ ...cell })));
      rowDirty.push(dirty === DirtyState.FULL ? true : dirty === DirtyState.NONE ? false : this.isRowDirty(y));
    }

    return new GhosttyRenderFrame({
      terminal: this,
      lines,
      rowDirty,
      cursor,
      dimensions: { cols: this._cols, rows: this._rows },
      fullRedraw: dirty === DirtyState.FULL,
    });
  }

  private getViewportFromCurrentRenderState(): GhosttyCell[] {
    this.prepareRowIterator();
    const defaultColors = this.getColors();
    let index = 0;

    for (let y = 0; y < this._rows; y++) {
      if (!this.exports.ghostty_render_state_row_iterator_next(this.rowIteratorHandle)) {
        break;
      }

      this.requireSuccess(
        this.exports.ghostty_render_state_row_get(
          this.rowIteratorHandle,
          RENDER_STATE_ROW_DATA_CELLS,
          this.writeHandleRef(this.scratchPtr, this.rowCellsHandle)
        ),
        'populate row cells'
      );

      for (let x = 0; x < this._cols; x++) {
        if (!this.exports.ghostty_render_state_row_cells_next(this.rowCellsHandle)) {
          break;
        }
        this.readCurrentRenderCell(this.cellPool[index++], defaultColors);
      }
    }

    return this.cellPool;
  }

  // ==========================================================================
  // Compatibility methods (delegate to render state)
  // ==========================================================================

  /**
   * Get line - for compatibility, extracts from viewport.
   * Ensures render state is fresh by calling update().
   * Returns a COPY of the cells to avoid pool reference issues.
   */
  getLine(y: number): GhosttyCell[] | null {
    if (y < 0 || y >= this._rows) return null;
    const frame = this.createRenderFrame();
    const line = frame.getLine(y);
    if (!line) return null;
    return line.map((cell) => ({ ...cell }));
  }

  /** For compatibility with old API */
  isDirty(): boolean {
    return this.update() !== DirtyState.NONE;
  }

  /**
   * Check if a full redraw is needed (screen change, resize, etc.)
   * Note: This calls update() to ensure fresh state. Safe to call multiple times.
   */
  needsFullRedraw(): boolean {
    return this.update() === DirtyState.FULL;
  }

  /** Mark render state as clean after rendering */
  clearDirty(): void {
    this.markClean();
  }

  // ==========================================================================
  // Terminal modes
  // ==========================================================================

  isAlternateScreen(): boolean {
    this.requireSuccess(
      this.exports.ghostty_terminal_get(this.handle, TERMINAL_DATA_ACTIVE_SCREEN, this.scratchPtr),
      'read active screen'
    );
    return this.readU32(this.scratchPtr) !== 0;
  }

  hasBracketedPaste(): boolean {
    // Mode 2004 = bracketed paste (DEC mode)
    return this.getMode(2004, false);
  }

  hasFocusEvents(): boolean {
    // Mode 1004 = focus events (DEC mode)
    return this.getMode(1004, false);
  }

  hasMouseTracking(): boolean {
    this.requireSuccess(
      this.exports.ghostty_terminal_get(this.handle, TERMINAL_DATA_MOUSE_TRACKING, this.scratchPtr),
      'read mouse tracking mode'
    );
    return this.readBool(this.scratchPtr);
  }

  // ==========================================================================
  // Extended API (scrollback, modes, etc.)
  // ==========================================================================

  /** Get dimensions - for compatibility */
  getDimensions(): { cols: number; rows: number } {
    return { cols: this._cols, rows: this._rows };
  }

  /** Get number of scrollback lines (history, not including active screen) */
  getScrollbackLength(): number {
    this.requireSuccess(
      this.exports.ghostty_terminal_get(this.handle, TERMINAL_DATA_SCROLLBAR, this.scratchPtr),
      'read terminal scrollbar'
    );
    const total = Number(this.readU64(this.scratchPtr + 0));
    const len = Number(this.readU64(this.scratchPtr + 16));
    return Math.max(0, total - len);
  }

  /**
   * Get a line from the scrollback buffer.
   * Ensures render state is fresh by calling update().
   * @param offset 0 = oldest line, (length-1) = most recent scrollback line
   */
  getScrollbackLine(offset: number): GhosttyCell[] | null {
    if (offset < 0 || offset >= this.getScrollbackLength()) {
      return null;
    }

    this.update();
    const defaultColors = this.getColors();
    const palette = this.getRenderPalette();
    const cells: GhosttyCell[] = [];

    for (let col = 0; col < this._cols; col++) {
      const ref = this.getHistoryGridRef(offset, col);
      if (!ref) {
        cells.push(this.makeEmptyCell(defaultColors));
        continue;
      }
      cells.push(this.readGridRefCell(ref, defaultColors, palette));
    }

    return cells;
  }

  /** Check if a row in the active screen is wrapped (soft-wrapped to next line) */
  isRowWrapped(row: number): boolean {
    if (row < 0 || row >= this._rows) return false;
    const ref = this.getViewportGridRef(row, 0);
    if (!ref) return false;
    this.requireSuccess(this.exports.ghostty_grid_ref_row(this.gridRefBufferPtr, this.rowBufferPtr), 'read row');
    this.requireSuccess(this.exports.ghostty_row_get(this.readU64BigInt(this.rowBufferPtr), ROW_DATA_WRAP_CONTINUATION, this.scratchPtr), 'read row wrap state');
    return this.readBool(this.scratchPtr);
  }

  /**
   * Get the hyperlink URI for a cell at the given position.
   * @param row Row index (0-based, in active viewport)
   * @param col Column index (0-based)
   * @returns The URI string, or null if no hyperlink at that position
   */
  getHyperlinkUri(row: number, col: number): string | null {
    // Check if WASM has this function (requires rebuilt WASM with hyperlink support)
    if (!this.exports.ghostty_terminal_get_hyperlink_uri) {
      return null;
    }

    // Try with initial buffer, retry with larger if needed (for very long URLs)
    const bufferSizes = [2048, 8192, 32768];

    for (const bufSize of bufferSizes) {
      const bufPtr = this.exports.ghostty_wasm_alloc_u8_array(bufSize);

      try {
        const bytesWritten = this.exports.ghostty_terminal_get_hyperlink_uri(
          this.handle,
          row,
          col,
          bufPtr,
          bufSize
        );

        // 0 means no hyperlink at this position
        if (bytesWritten === 0) return null;

        // -1 means buffer too small, try next size
        if (bytesWritten === -1) continue;

        // Negative values other than -1 are errors
        if (bytesWritten < 0) return null;

        const bytes = new Uint8Array(this.memory.buffer, bufPtr, bytesWritten);
        return new TextDecoder().decode(bytes.slice());
      } finally {
        this.exports.ghostty_wasm_free_u8_array(bufPtr, bufSize);
      }
    }

    // URI too long even for largest buffer
    return null;
  }

  /**
   * Get the hyperlink URI for a cell in the scrollback buffer.
   * @param offset Scrollback line offset (0 = oldest, scrollback_len-1 = newest)
   * @param col Column index (0-based)
   * @returns The URI string, or null if no hyperlink at that position
   */
  getScrollbackHyperlinkUri(offset: number, col: number): string | null {
    // Check if WASM has this function
    if (!this.exports.ghostty_terminal_get_scrollback_hyperlink_uri) {
      return null;
    }

    // Try with initial buffer, retry with larger if needed (for very long URLs)
    const bufferSizes = [2048, 8192, 32768];

    for (const bufSize of bufferSizes) {
      const bufPtr = this.exports.ghostty_wasm_alloc_u8_array(bufSize);

      try {
        const bytesWritten = this.exports.ghostty_terminal_get_scrollback_hyperlink_uri(
          this.handle,
          offset,
          col,
          bufPtr,
          bufSize
        );

        // 0 means no hyperlink at this position
        if (bytesWritten === 0) return null;

        // -1 means buffer too small, try next size
        if (bytesWritten === -1) continue;

        // Negative values other than -1 are errors
        if (bytesWritten < 0) return null;

        const bytes = new Uint8Array(this.memory.buffer, bufPtr, bytesWritten);
        return new TextDecoder().decode(bytes.slice());
      } finally {
        this.exports.ghostty_wasm_free_u8_array(bufPtr, bufSize);
      }
    }

    // URI too long even for largest buffer
    return null;
  }

  /**
   * Check if there are pending responses from the terminal.
   * Responses are generated by escape sequences like DSR (Device Status Report).
   */
  hasResponse(): boolean {
    return this.exports.ghostty_terminal_has_response?.(this.handle) ?? false;
  }

  /**
   * Read pending responses from the terminal.
   * Returns the response string, or null if no responses pending.
   *
   * Responses are generated by escape sequences that require replies:
   * - DSR 6 (cursor position): Returns \x1b[row;colR
   * - DSR 5 (operating status): Returns \x1b[0n
   */
  readResponse(): string | null {
    if (!this.hasResponse()) return null;

    const bufSize = 256; // Most responses are small
    const bufPtr = this.exports.ghostty_wasm_alloc_u8_array(bufSize);

    try {
      const readResponse = this.exports.ghostty_terminal_read_response;
      if (!readResponse) {
        return null;
      }

      const bytesRead = readResponse(this.handle, bufPtr, bufSize);

      if (bytesRead <= 0) return null;

      const bytes = new Uint8Array(this.memory.buffer, bufPtr, bytesRead);
      return new TextDecoder().decode(bytes.slice());
    } finally {
      this.exports.ghostty_wasm_free_u8_array(bufPtr, bufSize);
    }
  }

  /**
   * Query arbitrary terminal mode by number
   * @param mode Mode number (e.g., 25 for cursor visibility, 2004 for bracketed paste)
   * @param isAnsi True for ANSI modes, false for DEC modes (default: false)
   */
  getMode(mode: number, isAnsi: boolean = false): boolean {
    this.requireSuccess(
      this.exports.ghostty_terminal_mode_get(this.handle, this.packMode(mode, isAnsi), this.scratchPtr),
      `read terminal mode ${mode}`
    );
    return this.readBool(this.scratchPtr);
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private createRenderState(): RenderStateHandle {
    const resultPtr = this.exports.ghostty_wasm_alloc_opaque();
    try {
      const result = this.exports.ghostty_render_state_new(0, resultPtr);
      if (result !== 0) {
        throw new Error(`Failed to create render state: ${result}`);
      }
      const view = new DataView(this.memory.buffer);
      return view.getUint32(resultPtr, true);
    } finally {
      this.exports.ghostty_wasm_free_opaque(resultPtr);
    }
  }

  private createRowIterator(): RenderStateRowIteratorHandle {
    const resultPtr = this.exports.ghostty_wasm_alloc_opaque();
    try {
      const result = this.exports.ghostty_render_state_row_iterator_new(0, resultPtr);
      if (result !== 0) {
        throw new Error(`Failed to create row iterator: ${result}`);
      }
      return new DataView(this.memory.buffer).getUint32(resultPtr, true);
    } finally {
      this.exports.ghostty_wasm_free_opaque(resultPtr);
    }
  }

  private createRowCells(): RenderStateRowCellsHandle {
    const resultPtr = this.exports.ghostty_wasm_alloc_opaque();
    try {
      const result = this.exports.ghostty_render_state_row_cells_new(0, resultPtr);
      if (result !== 0) {
        throw new Error(`Failed to create row cells: ${result}`);
      }
      return new DataView(this.memory.buffer).getUint32(resultPtr, true);
    } finally {
      this.exports.ghostty_wasm_free_opaque(resultPtr);
    }
  }

  private allocBuffers(): void {
    this.scratchPtr = this.exports.ghostty_wasm_alloc_u8_array(1024);
    this.styleBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(STYLE_SIZE);
    this.renderColorsBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(792);
    this.pointBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(POINT_SIZE);
    this.gridRefBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(GRID_REF_SIZE);
    this.rowBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(8);
    this.cellBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(8);
  }

  private initCellPool(): void {
    const total = this._cols * this._rows;
    if (this.cellPool.length < total) {
      for (let i = this.cellPool.length; i < total; i++) {
        this.cellPool.push({
          codepoint: 0,
          fg_r: 204,
          fg_g: 204,
          fg_b: 204,
          bg_r: 0,
          bg_g: 0,
          bg_b: 0,
          flags: 0,
          width: 1,
          hyperlink_id: 0,
          grapheme_len: 0,
        });
      }
    }
  }

  /** Small buffer for grapheme lookups (reused to avoid allocation) */
  private graphemeBuffer: Uint32Array | null = null;
  private graphemeBufferPtr: number = 0;

  /**
   * Get all codepoints for a grapheme cluster at the given position.
   * For most cells this returns a single codepoint, but for complex scripts
   * (Hindi, emoji with ZWJ, etc.) it returns multiple codepoints.
   * @returns Array of codepoints, or null on error
   */
  getGrapheme(row: number, col: number): number[] | null {
    this.update();
    return this.getGraphemeFromCurrentRenderState(row, col);
  }

  getGraphemeStringFromCurrentRenderState(row: number, col: number): string {
    const codepoints = this.getGraphemeFromCurrentRenderState(row, col);
    if (!codepoints || codepoints.length === 0) return ' ';
    return String.fromCodePoint(...codepoints);
  }

  private getGraphemeFromCurrentRenderState(row: number, col: number): number[] | null {
    if (row < 0 || col < 0 || row >= this._rows || col >= this._cols) {
      return null;
    }
    const ref = this.getViewportGridRef(row, col);
    if (!ref) return null;
    return this.readGraphemesFromGridRef(ref);
  }

  /**
   * Get a string representation of the grapheme at the given position.
   * This properly handles complex scripts like Hindi, emoji with ZWJ, etc.
   */
  getGraphemeString(row: number, col: number): string {
    this.update();
    return this.getGraphemeStringFromCurrentRenderState(row, col);
  }

  /**
   * Get all codepoints for a grapheme cluster in the scrollback buffer.
   * @param offset Scrollback line offset (0 = oldest)
   * @param col Column index
   * @returns Array of codepoints, or null on error
   */
  getScrollbackGrapheme(offset: number, col: number): number[] | null {
    const ref = this.getHistoryGridRef(offset, col);
    if (!ref) return null;
    return this.readGraphemesFromGridRef(ref);
  }

  /**
   * Get a string representation of a grapheme in the scrollback buffer.
   */
  getScrollbackGraphemeString(offset: number, col: number): string {
    const codepoints = this.getScrollbackGrapheme(offset, col);
    if (!codepoints || codepoints.length === 0) return ' ';
    return String.fromCodePoint(...codepoints);
  }

  private invalidateBuffers(): void {
    if (this.graphemeBufferPtr) {
      this.exports.ghostty_wasm_free_u8_array(this.graphemeBufferPtr, 16 * 4);
      this.graphemeBufferPtr = 0;
    }
    this.graphemeBuffer = null;
  }

  private getCursorFromCurrentRenderState(): RenderStateCursor {
    this.requireSuccess(
      this.exports.ghostty_render_state_get(
        this.renderStateHandle,
        RENDER_STATE_DATA_CURSOR_VISIBLE,
        this.scratchPtr
      ),
      'read cursor visibility'
    );
    const visible = this.readBool(this.scratchPtr);

    this.requireSuccess(
      this.exports.ghostty_render_state_get(
        this.renderStateHandle,
        RENDER_STATE_DATA_CURSOR_BLINKING,
        this.scratchPtr
      ),
      'read cursor blinking'
    );
    const blinking = this.readBool(this.scratchPtr);

    this.requireSuccess(
      this.exports.ghostty_render_state_get(
        this.renderStateHandle,
        RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE,
        this.scratchPtr
      ),
      'read cursor viewport presence'
    );
    const hasViewportPosition = this.readBool(this.scratchPtr);

    let viewportX = -1;
    let viewportY = -1;
    if (hasViewportPosition) {
      this.requireSuccess(
        this.exports.ghostty_render_state_get(
          this.renderStateHandle,
          RENDER_STATE_DATA_CURSOR_VIEWPORT_X,
          this.scratchPtr
        ),
        'read cursor viewport x'
      );
      viewportX = this.readU16(this.scratchPtr);

      this.requireSuccess(
        this.exports.ghostty_render_state_get(
          this.renderStateHandle,
          RENDER_STATE_DATA_CURSOR_VIEWPORT_Y,
          this.scratchPtr
        ),
        'read cursor viewport y'
      );
      viewportY = this.readU16(this.scratchPtr);
    }

    this.requireSuccess(
      this.exports.ghostty_terminal_get(this.handle, 3, this.scratchPtr),
      'read cursor x'
    );
    const x = this.readU16(this.scratchPtr);

    this.requireSuccess(
      this.exports.ghostty_terminal_get(this.handle, 4, this.scratchPtr),
      'read cursor y'
    );
    const y = this.readU16(this.scratchPtr);

    this.requireSuccess(
      this.exports.ghostty_render_state_get(
        this.renderStateHandle,
        RENDER_STATE_DATA_CURSOR_VISUAL_STYLE,
        this.scratchPtr
      ),
      'read cursor style'
    );
    const styleValue = this.readU32(this.scratchPtr);

    return {
      x,
      y,
      viewportX,
      viewportY,
      visible,
      blinking,
      style: styleValue === 0 ? 'bar' : styleValue === 2 ? 'underline' : 'block',
    };
  }

  private getRenderStateDirty(): DirtyState {
    this.requireSuccess(
      this.exports.ghostty_render_state_get(this.renderStateHandle, RENDER_STATE_DATA_DIRTY, this.scratchPtr),
      'read render-state dirty flag'
    );
    return this.readU32(this.scratchPtr) as DirtyState;
  }

  private getRenderStateColor(data: number): RGB {
    this.requireSuccess(
      this.exports.ghostty_render_state_get(this.renderStateHandle, data, this.scratchPtr),
      'read render-state color'
    );
    return this.readRgb(this.scratchPtr);
  }

  private getRenderPalette(): RGB[] {
    this.writeU32(this.renderColorsBufferPtr, 792);
    this.requireSuccess(
      this.exports.ghostty_render_state_colors_get(this.renderStateHandle, this.renderColorsBufferPtr),
      'read render-state palette'
    );

    const palette: RGB[] = [];
    for (let i = 0; i < 256; i++) {
      palette.push(this.readRgb(this.renderColorsBufferPtr + 18 + i * 3));
    }
    return palette;
  }

  private prepareRowIterator(): void {
    this.writeHandleRef(this.scratchPtr, this.rowIteratorHandle);
    this.requireSuccess(
      this.exports.ghostty_render_state_get(
        this.renderStateHandle,
        RENDER_STATE_DATA_ROW_ITERATOR,
        this.scratchPtr
      ),
      'prepare row iterator'
    );
  }

  private readCurrentRenderCell(target: GhosttyCell, defaultColors: RenderStateColors): void {
    this.requireSuccess(
      this.exports.ghostty_render_state_row_cells_get(
        this.rowCellsHandle,
        RENDER_STATE_ROW_CELLS_DATA_RAW,
        this.cellBufferPtr
      ),
      'read render cell'
    );
    const rawCell = this.readU64BigInt(this.cellBufferPtr);

    target.codepoint = this.readCellCodepoint(rawCell);
    target.flags = this.readCurrentCellFlags();
    target.width = this.readCellWidth(rawCell);
    target.hyperlink_id = this.readCellHasHyperlink(rawCell) ? 1 : 0;

    const fg = this.tryReadCurrentCellColor(RENDER_STATE_ROW_CELLS_DATA_FG_COLOR);
    const bg = this.tryReadCurrentCellColor(RENDER_STATE_ROW_CELLS_DATA_BG_COLOR);

    target.fg_r = (fg ?? defaultColors.foreground).r;
    target.fg_g = (fg ?? defaultColors.foreground).g;
    target.fg_b = (fg ?? defaultColors.foreground).b;
    target.bg_r = (bg ?? defaultColors.background).r;
    target.bg_g = (bg ?? defaultColors.background).g;
    target.bg_b = (bg ?? defaultColors.background).b;

    const grapheme = this.readCurrentRenderCellGrapheme();
    target.grapheme_len = grapheme ? Math.max(0, grapheme.length - 1) : 0;
    target.grapheme =
      grapheme && grapheme.length > 1 ? String.fromCodePoint(...grapheme) : undefined;
  }

  private readCurrentCellFlags(): number {
    this.requireSuccess(
      this.exports.ghostty_render_state_row_cells_get(
        this.rowCellsHandle,
        RENDER_STATE_ROW_CELLS_DATA_STYLE,
        this.styleBufferPtr
      ),
      'read render cell style'
    );

    let flags = 0;
    if (this.readBool(this.styleBufferPtr + 56)) flags |= CellFlags.BOLD;
    if (this.readBool(this.styleBufferPtr + 57)) flags |= CellFlags.ITALIC;
    if (this.readU32(this.styleBufferPtr + 64) !== 0) flags |= CellFlags.UNDERLINE;
    if (this.readBool(this.styleBufferPtr + 62)) flags |= CellFlags.STRIKETHROUGH;
    if (this.readBool(this.styleBufferPtr + 60)) flags |= CellFlags.INVERSE;
    if (this.readBool(this.styleBufferPtr + 61)) flags |= CellFlags.INVISIBLE;
    if (this.readBool(this.styleBufferPtr + 59)) flags |= CellFlags.BLINK;
    if (this.readBool(this.styleBufferPtr + 58)) flags |= CellFlags.FAINT;
    return flags;
  }

  private tryReadCurrentCellColor(data: number): RGB | null {
    const result = this.exports.ghostty_render_state_row_cells_get(this.rowCellsHandle, data, this.scratchPtr);
    if (result !== 0) return null;
    return this.readRgb(this.scratchPtr);
  }

  private readCurrentRenderCellGrapheme(): number[] | null {
    this.requireSuccess(
      this.exports.ghostty_render_state_row_cells_get(
        this.rowCellsHandle,
        RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN,
        this.scratchPtr
      ),
      'read render cell grapheme length'
    );
    const len = this.readU32(this.scratchPtr);
    if (len === 0) return null;
    this.ensureGraphemeCapacity(len);
    this.requireSuccess(
      this.exports.ghostty_render_state_row_cells_get(
        this.rowCellsHandle,
        RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF,
        this.graphemeBufferPtr
      ),
      'read render cell grapheme'
    );
    return Array.from(new Uint32Array(this.memory.buffer, this.graphemeBufferPtr, len));
  }

  private readCellCodepoint(rawCell: bigint): number {
    this.requireSuccess(this.exports.ghostty_cell_get(rawCell, CELL_DATA_CODEPOINT, this.scratchPtr), 'read cell codepoint');
    return this.readU32(this.scratchPtr);
  }

  private readCellWidth(rawCell: bigint): number {
    this.requireSuccess(this.exports.ghostty_cell_get(rawCell, CELL_DATA_WIDE, this.scratchPtr), 'read cell width');
    const wide = this.readU32(this.scratchPtr);
    switch (wide) {
      case WIDE_WIDE:
        return 2;
      case WIDE_SPACER_TAIL:
      case WIDE_SPACER_HEAD:
        return 0;
      case WIDE_NARROW:
      default:
        return 1;
    }
  }

  private readCellHasHyperlink(rawCell: bigint): boolean {
    this.requireSuccess(
      this.exports.ghostty_cell_get(rawCell, CELL_DATA_HAS_HYPERLINK, this.scratchPtr),
      'read cell hyperlink flag'
    );
    return this.readBool(this.scratchPtr);
  }

  private getViewportGridRef(row: number, col: number): number | null {
    return this.populateGridRef(1, row, col);
  }

  private getHistoryGridRef(offset: number, col: number): number | null {
    return this.populateGridRef(POINT_TAG_HISTORY, offset, col);
  }

  private populateGridRef(tag: number, row: number, col: number): number | null {
    this.writePoint(tag, col, row);
    this.writeU32(this.gridRefBufferPtr, GRID_REF_SIZE);
    const result = this.exports.ghostty_terminal_grid_ref(
      this.handle,
      this.pointBufferPtr,
      this.gridRefBufferPtr
    );
    return result === 0 ? this.gridRefBufferPtr : null;
  }

  private readGridRefCell(refPtr: number, defaultColors: RenderStateColors, palette: RGB[]): GhosttyCell {
    this.requireSuccess(this.exports.ghostty_grid_ref_cell(refPtr, this.cellBufferPtr), 'read grid-ref cell');
    const rawCell = this.readU64BigInt(this.cellBufferPtr);
    this.requireSuccess(this.exports.ghostty_grid_ref_style(refPtr, this.styleBufferPtr), 'read grid-ref style');

    const grapheme = this.readGraphemesFromGridRef(refPtr);
    return {
      codepoint: this.readCellCodepoint(rawCell),
      flags: this.readStyleFlagsFromBuffer(),
      width: this.readCellWidth(rawCell),
      hyperlink_id: this.readCellHasHyperlink(rawCell) ? 1 : 0,
      grapheme_len: grapheme ? Math.max(0, grapheme.length - 1) : 0,
      grapheme: grapheme && grapheme.length > 1 ? String.fromCodePoint(...grapheme) : undefined,
      ...this.resolveStyleColors(defaultColors, palette),
    };
  }

  private resolveStyleColors(defaultColors: RenderStateColors, palette: RGB[]): Pick<GhosttyCell, 'fg_r' | 'fg_g' | 'fg_b' | 'bg_r' | 'bg_g' | 'bg_b'> {
    const fg = this.readStyleColorFromBuffer(8, palette) ?? defaultColors.foreground;
    const bg = this.readStyleColorFromBuffer(24, palette) ?? defaultColors.background;
    return {
      fg_r: fg.r,
      fg_g: fg.g,
      fg_b: fg.b,
      bg_r: bg.r,
      bg_g: bg.g,
      bg_b: bg.b,
    };
  }

  private readStyleFlagsFromBuffer(): number {
    let flags = 0;
    if (this.readBool(this.styleBufferPtr + 56)) flags |= CellFlags.BOLD;
    if (this.readBool(this.styleBufferPtr + 57)) flags |= CellFlags.ITALIC;
    if (this.readU32(this.styleBufferPtr + 64) !== 0) flags |= CellFlags.UNDERLINE;
    if (this.readBool(this.styleBufferPtr + 62)) flags |= CellFlags.STRIKETHROUGH;
    if (this.readBool(this.styleBufferPtr + 60)) flags |= CellFlags.INVERSE;
    if (this.readBool(this.styleBufferPtr + 61)) flags |= CellFlags.INVISIBLE;
    if (this.readBool(this.styleBufferPtr + 59)) flags |= CellFlags.BLINK;
    if (this.readBool(this.styleBufferPtr + 58)) flags |= CellFlags.FAINT;
    return flags;
  }

  private readStyleColorFromBuffer(offset: number, palette: RGB[]): RGB | null {
    const tag = this.readU32(this.styleBufferPtr + offset);
    if (tag === 0) return null;
    if (tag === 1) {
      const index = new Uint8Array(this.memory.buffer, this.styleBufferPtr + offset + 8, 1)[0];
      return palette[index] ?? null;
    }
    return this.readRgb(this.styleBufferPtr + offset + 8);
  }

  private readGraphemesFromGridRef(refPtr: number): number[] | null {
    this.writeU32(this.scratchPtr, 0);
    let result = this.exports.ghostty_grid_ref_graphemes(refPtr, 0, 0, this.scratchPtr);
    const needed = this.readU32(this.scratchPtr);
    if (result === 0 && needed === 0) return null;
    if (result !== 0 && needed === 0) return null;

    this.ensureGraphemeCapacity(needed);
    result = this.exports.ghostty_grid_ref_graphemes(
      refPtr,
      this.graphemeBufferPtr,
      needed,
      this.scratchPtr
    );
    if (result !== 0) return null;
    const count = this.readU32(this.scratchPtr);
    return Array.from(new Uint32Array(this.memory.buffer, this.graphemeBufferPtr, count));
  }

  private ensureGraphemeCapacity(len: number): void {
    const neededBytes = Math.max(16 * 4, len * 4);
    if (!this.graphemeBufferPtr || !this.graphemeBuffer || this.graphemeBuffer.byteLength < neededBytes) {
      if (this.graphemeBufferPtr && this.graphemeBuffer) {
        this.exports.ghostty_wasm_free_u8_array(this.graphemeBufferPtr, this.graphemeBuffer.byteLength);
      }
      this.graphemeBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(neededBytes);
      this.graphemeBuffer = new Uint32Array(this.memory.buffer, this.graphemeBufferPtr, neededBytes / 4);
    }
  }

  private makeEmptyCell(defaultColors: RenderStateColors): GhosttyCell {
    return {
      codepoint: 0,
      fg_r: defaultColors.foreground.r,
      fg_g: defaultColors.foreground.g,
      fg_b: defaultColors.foreground.b,
      bg_r: defaultColors.background.r,
      bg_g: defaultColors.background.g,
      bg_b: defaultColors.background.b,
      flags: 0,
      width: 1,
      hyperlink_id: 0,
      grapheme_len: 0,
    };
  }

  private packMode(mode: number, isAnsi: boolean): number {
    return (mode & 0x7fff) | (isAnsi ? 0x8000 : 0);
  }

  private requireSuccess(result: number, operation: string): void {
    if (result !== 0) {
      throw new Error(`Failed to ${operation}: ${result}`);
    }
  }

  private readRgb(ptr: number): RGB {
    const bytes = new Uint8Array(this.memory.buffer, ptr, 3);
    return { r: bytes[0], g: bytes[1], b: bytes[2] };
  }

  private writePoint(tag: number, x: number, y: number): void {
    new Uint8Array(this.memory.buffer, this.pointBufferPtr, POINT_SIZE).fill(0);
    this.writeU32(this.pointBufferPtr + 0, tag);
    this.writeU16(this.pointBufferPtr + 8, x);
    this.writeU32(this.pointBufferPtr + 12, y);
  }

  private writeHandleRef(ptr: number, handle: number): number {
    this.writeU32(ptr, handle);
    return ptr;
  }

  private readBool(ptr: number): boolean {
    return new Uint8Array(this.memory.buffer, ptr, 1)[0] !== 0;
  }

  private writeBool(ptr: number, value: boolean): void {
    new Uint8Array(this.memory.buffer, ptr, 1)[0] = value ? 1 : 0;
  }

  private readU16(ptr: number): number {
    return new DataView(this.memory.buffer).getUint16(ptr, true);
  }

  private writeU16(ptr: number, value: number): void {
    new DataView(this.memory.buffer).setUint16(ptr, value, true);
  }

  private readU32(ptr: number): number {
    return new DataView(this.memory.buffer).getUint32(ptr, true);
  }

  private writeU32(ptr: number, value: number): void {
    new DataView(this.memory.buffer).setUint32(ptr, value, true);
  }

  private readU64(ptr: number): bigint {
    return new DataView(this.memory.buffer).getBigUint64(ptr, true);
  }

  private readU64BigInt(ptr: number): bigint {
    return this.readU64(ptr);
  }
}
