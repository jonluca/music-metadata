import * as Token from 'token-types';
import { type IGetToken, EndOfStreamError } from 'strtok3';
import initDebug from 'debug';

import * as util from '../common/Util.js';
import { FourCcToken } from '../common/FourCC.js';
import { BasicParser } from '../common/BasicParser.js';

import { VorbisParser } from './vorbis/VorbisParser.js';
import { OpusParser } from './opus/OpusParser.js';
import { SpeexParser } from './speex/SpeexParser.js';
import { TheoraParser } from './theora/TheoraParser.js';

import type * as Ogg from './Ogg.js';
import { makeUnexpectedFileContentError } from '../ParseError.js';

export class OggContentError extends makeUnexpectedFileContentError('Ogg'){
}

const debug = initDebug('music-metadata:parser:ogg');

export class SegmentTable implements IGetToken<Ogg.ISegmentTable> {

  private static sum(buf: Uint8Array, off: number, len: number): number {
    const dv = new DataView(buf.buffer, 0);
    let s = 0;
    for (let i = off; i < off + len; ++i) {
      s += dv.getUint8(i);
    }
    return s;
  }

  public len: number;

  constructor(header: Ogg.IPageHeader) {
    this.len = header.page_segments;
  }

  public get(buf: Uint8Array, off: number): Ogg.ISegmentTable {
    return {
      totalPageSize: SegmentTable.sum(buf, off, this.len)
    };
  }

}

/**
 * Parser for Ogg logical bitstream framing
 */
export class OggParser extends BasicParser {

  private static Header: IGetToken<Ogg.IPageHeader> = {
    len: 27,

    get: (buf, off): Ogg.IPageHeader => {
      return {
        capturePattern: FourCcToken.get(buf, off),
        version: Token.UINT8.get(buf, off + 4),

        headerType: {
          continued: util.getBit(buf, off + 5, 0),
          firstPage: util.getBit(buf, off + 5, 1),
          lastPage: util.getBit(buf, off + 5, 2)
        },
        // packet_flag: Token.UINT8.get(buf, off + 5),
        absoluteGranulePosition: Number(Token.UINT64_LE.get(buf, off + 6)),
        streamSerialNumber: Token.UINT32_LE.get(buf, off + 14),
        pageSequenceNo: Token.UINT32_LE.get(buf, off + 18),
        pageChecksum: Token.UINT32_LE.get(buf, off + 22),
        page_segments: Token.UINT8.get(buf, off + 26)
      };
    }
  };

  private header: Ogg.IPageHeader = null as unknown as Ogg.IPageHeader;
  private pageNumber = 0;
  private pageConsumer: Ogg.IPageConsumer = null as unknown as Ogg.IPageConsumer;

  /**
   * Parse page
   * @returns {Promise<void>}
   */
  public async parse(): Promise<void> {
    debug('pos=%s, parsePage()', this.tokenizer.position);
    try {
      let header: Ogg.IPageHeader;
      do {
        header = await this.tokenizer.readToken<Ogg.IPageHeader>(OggParser.Header);

        if (header.capturePattern !== 'OggS') throw new OggContentError('Invalid Ogg capture pattern');
        this.metadata.setFormat('container', 'Ogg');
        this.header = header;

        this.pageNumber = header.pageSequenceNo;
        debug('page#=%s, Ogg.id=%s', header.pageSequenceNo, header.capturePattern);

        const segmentTable = await this.tokenizer.readToken<Ogg.ISegmentTable>(new SegmentTable(header));
        debug('totalPageSize=%s', segmentTable.totalPageSize);
        const pageData = await this.tokenizer.readToken<Uint8Array>(new Token.Uint8ArrayType(segmentTable.totalPageSize));
        debug('firstPage=%s, lastPage=%s, continued=%s', header.headerType.firstPage, header.headerType.lastPage, header.headerType.continued);
        if (header.headerType.firstPage) {
          const id = new TextDecoder('ascii').decode(pageData.subarray(0, 7));
          switch (id) {
            case '\x01vorbis': // Ogg/Vorbis
              debug('Set page consumer to Ogg/Vorbis');
              this.pageConsumer = new VorbisParser(this.metadata, this.options);
              break;
            case 'OpusHea': // Ogg/Opus
              debug('Set page consumer to Ogg/Opus');
              this.pageConsumer = new OpusParser(this.metadata, this.options, this.tokenizer);
              break;
            case 'Speex  ': // Ogg/Speex
              debug('Set page consumer to Ogg/Speex');
              this.pageConsumer = new SpeexParser(this.metadata, this.options, this.tokenizer);
              break;
            case 'fishead':
            case '\x00theora': // Ogg/Theora
              debug('Set page consumer to Ogg/Theora');
              this.pageConsumer = new TheoraParser(this.metadata, this.options, this.tokenizer);
              break;
            default:
              throw new OggContentError(`gg audio-codec not recognized (id=${id})`);
          }
        }
        await this.pageConsumer.parsePage(header, pageData);
      } while (!header.headerType.lastPage);
    } catch (err) {
      if (err instanceof Error) {
        if (err instanceof EndOfStreamError) {
          this.metadata.addWarning('Last OGG-page is not marked with last-page flag');
          debug("End-of-stream");
          this.metadata.addWarning('Last OGG-page is not marked with last-page flag');
          if (this.header) {
            this.pageConsumer.calculateDuration(this.header);
          }
        } else if (err.message.startsWith('FourCC')) {
          if (this.pageNumber > 0) {
            // ignore this error: work-around if last OGG-page is not marked with last-page flag
            this.metadata.addWarning('Invalid FourCC ID, maybe last OGG-page is not marked with last-page flag');
            await this.pageConsumer.flush();
          }
        }
      } else throw err;
    }
  }

}
