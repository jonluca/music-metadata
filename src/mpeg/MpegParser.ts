import * as assert from 'assert';
import * as Token from 'token-types';
import { endOfFile } from 'strtok3/lib/type';
import * as initDebug from 'debug';

import Common from '../common/Util';
import { AbstractID3Parser } from '../id3v2/AbstractID3Parser';
import { InfoTagHeaderTag, IXingInfoTag, LameEncoderVersion, XingInfoTag } from './XingTag';

const debug = initDebug('music-metadata:parser:mpeg');

/**
 * Cache buffer size used for searching synchronization preabmle
 */
const maxPeekLen = 1024;

type MPEG4Channel = 'front-center' | 'front-left' | 'front-right' | 'side-left' | 'side-right' | 'back-left' | 'back-right' | 'back-center' | 'LFE-channel';

type MPEG4ChannelConfiguration = MPEG4Channel[];

/**
 * MPEG-4 Audio definitions
 * Ref:  https://wiki.multimedia.cx/index.php/MPEG-4_Audio
 */
const MPEG4 = {

  /**
   * Audio Object Types
   */
  AudioObjectTypes: [
    'AAC Main',
    'AAC LC', // Low Complexity
    'AAC SSR', // Scalable Sample Rate
    'AAC LTP' // Long Term Prediction
  ],

  /**
   * Sampling Frequencies
   * https://wiki.multimedia.cx/index.php/MPEG-4_Audio#Sampling_Frequencies
   */
  SamplingFrequencies: [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350, undefined, undefined, -1]

  /**
   * Channel Configurations
   */
};

const MPEG4_ChannelConfigurations: MPEG4ChannelConfiguration[] = [
  undefined,
  ['front-center'],
  ['front-left', 'front-right'],
  ['front-center', 'front-left', 'front-right'],
  ['front-center', 'front-left', 'front-right', 'back-center'],
  ['front-center', 'front-left', 'front-right', 'back-left', 'back-right'],
  ['front-center', 'front-left', 'front-right', 'back-left', 'back-right', 'LFE-channel'],
  ['front-center', 'front-left', 'front-right', 'side-left', 'side-right', 'back-left', 'back-right', 'LFE-channel']
];

/**
 * MPEG Audio Layer I/II/III frame header
 * Ref: https://www.mp3-tech.org/programmer/frame_header.html
 * Bit layout: AAAAAAAA AAABBCCD EEEEFFGH IIJJKLMM
 * Ref: https://wiki.multimedia.cx/index.php/ADTS
 */
class MpegFrameHeader {

  public static SyncByte1 = 0xFF;
  public static SyncByte2 = 0xE0;

  public static VersionID = [2.5, null, 2, 1];
  public static LayerDescription = [0, 3, 2, 1];
  public static ChannelMode = ['stereo', 'joint_stereo', 'dual_channel', 'mono'];

  private static bitrate_index = {
    0x01: {11: 32, 12: 32, 13: 32, 21: 32, 22: 8, 23: 8},
    0x02: {11: 64, 12: 48, 13: 40, 21: 48, 22: 16, 23: 16},
    0x03: {11: 96, 12: 56, 13: 48, 21: 56, 22: 24, 23: 24},
    0x04: {11: 128, 12: 64, 13: 56, 21: 64, 22: 32, 23: 32},
    0x05: {11: 160, 12: 80, 13: 64, 21: 80, 22: 40, 23: 40},
    0x06: {11: 192, 12: 96, 13: 80, 21: 96, 22: 48, 23: 48},
    0x07: {11: 224, 12: 112, 13: 96, 21: 112, 22: 56, 23: 56},
    0x08: {11: 256, 12: 128, 13: 112, 21: 128, 22: 64, 23: 64},
    0x09: {11: 288, 12: 160, 13: 128, 21: 144, 22: 80, 23: 80},
    0x0A: {11: 320, 12: 192, 13: 160, 21: 160, 22: 96, 23: 96},
    0x0B: {11: 352, 12: 224, 13: 192, 21: 176, 22: 112, 23: 112},
    0x0C: {11: 384, 12: 256, 13: 224, 21: 192, 22: 128, 23: 128},
    0x0D: {11: 416, 12: 320, 13: 256, 21: 224, 22: 144, 23: 144},
    0x0E: {11: 448, 12: 384, 13: 320, 21: 256, 22: 160, 23: 160}
  };

  private static sampling_rate_freq_index = {
    1: {0x00: 44100, 0x01: 48000, 0x02: 32000},
    2: {0x00: 22050, 0x01: 24000, 0x02: 16000},
    2.5: {0x00: 11025, 0x01: 12000, 0x02: 8000}
  };

  private static samplesInFrameTable = [
    /* Layer   I    II   III */
    [0, 384, 1152, 1152], // MPEG-1
    [0, 384, 1152, 576] // MPEG-2(.5
  ];

  // B(20,19): MPEG Audio versionIndex ID
  public versionIndex: number;
  // C(18,17): Layer description
  public layer: number;
  // D(16): Protection bit
  public isProtectedByCRC: boolean;
  // E(15,12): Bitrate index
  public bitrateIndex: number;
  // F(11,10): Sampling rate frequency index
  public sampRateFreqIndex: number;
  // G(9): Padding bit
  public padding: boolean;
  // H(8): Private bit
  public privateBit: boolean;
  // I(7,6): Channel Mode
  public channelModeIndex: number;
  // J(5,4): Mode extension (Only used in Joint stereo)
  public modeExtension: number;
  // K(3): Copyright
  public isCopyrighted: boolean;
  // L(2): Original
  public isOriginalMedia: boolean;
  // M(3): The original bit indicates, if it is set, that the frame is located on its original media.
  public emphasis: number;

  public version: number;
  public channelMode: string;
  public bitrate: number;
  public samplingRate: number;

  public container: string;
  public codec: string;
  public codecProfile: string;

  public frameLength: number;

  public mp4ChannelConfig: MPEG4ChannelConfiguration;

  public constructor(buf: Buffer, off: number) {
    // B(20,19): MPEG Audio versionIndex ID
    this.versionIndex = Common.getBitAllignedNumber(buf, off + 1, 3, 2);
    // C(18,17): Layer description
    this.layer = MpegFrameHeader.LayerDescription[Common.getBitAllignedNumber(buf, off + 1, 5, 2)];

    if (this.versionIndex > 1 && this.layer === 0) {
      this.parseAdtsHeader(buf, off); // Audio Data Transport Stream (ADTS)
    } else {
      this.parseMpegHeader(buf, off); // Conventional MPEG header
    }

    // D(16): Protection bit (if true 16-bit CRC follows header)
    this.isProtectedByCRC = !Common.isBitSet(buf, off + 1, 7);
  }

  public calcDuration(numFrames: number): number {
    return numFrames * this.calcSamplesPerFrame() / this.samplingRate;
  }

  public calcSamplesPerFrame(): number {
    return MpegFrameHeader.samplesInFrameTable[this.version === 1 ? 0 : 1][this.layer];
  }

  public calculateSideInfoLength(): number {
    if (this.layer !== 3) return 2;
    if (this.channelModeIndex === 3) {
      // mono
      if (this.version === 1) {
        return 17;
      } else if (this.version === 2 || this.version === 2.5) {
        return 9;
      }
    } else {
      if (this.version === 1) {
        return 32;
      } else if (this.version === 2 || this.version === 2.5) {
        return 17;
      }
    }
  }

  public calcSlotSize(): number {
    return [null, 4, 1, 1][this.layer];
  }

  private parseMpegHeader(buf: Buffer, off: number): void {
    this.container = 'MPEG';
    // E(15,12): Bitrate index
    this.bitrateIndex = Common.getBitAllignedNumber(buf, off + 2, 0, 4);
    // F(11,10): Sampling rate frequency index
    this.sampRateFreqIndex = Common.getBitAllignedNumber(buf, off + 2, 4, 2);
    // G(9): Padding bit
    this.padding = Common.isBitSet(buf, off + 2, 6);
    // H(8): Private bit
    this.privateBit = Common.isBitSet(buf, off + 2, 7);
    // I(7,6): Channel Mode
    this.channelModeIndex = Common.getBitAllignedNumber(buf, off + 3, 0, 2);
    // J(5,4): Mode extension (Only used in Joint stereo)
    this.modeExtension = Common.getBitAllignedNumber(buf, off + 3, 2, 2);
    // K(3): Copyright
    this.isCopyrighted = Common.isBitSet(buf, off + 3, 4);
    // L(2): Original
    this.isOriginalMedia = Common.isBitSet(buf, off + 3, 5);
    // M(3): The original bit indicates, if it is set, that the frame is located on its original media.
    this.emphasis = Common.getBitAllignedNumber(buf, off + 3, 7, 2);

    this.version = MpegFrameHeader.VersionID[this.versionIndex];
    this.channelMode = MpegFrameHeader.ChannelMode[this.channelModeIndex];

    this.codec = 'MP' + this.layer;

    // Calculate bitrate
    const bitrateInKbps = this.calcBitrate();
    if (!bitrateInKbps) {
      throw new Error('Cannot determine bit-rate');
    }
    this.bitrate = bitrateInKbps * 1000;

    // Calculate sampling rate
    this.samplingRate = this.calcSamplingRate();
    if (this.samplingRate == null) {
      throw new Error('Cannot determine sampling-rate');
    }
  }

  private parseAdtsHeader(buf: Buffer, off: number): void {
    debug(`layer=0 => ADTS`);
    this.version = this.versionIndex === 2 ? 4 : 2;
    this.container = 'ADTS/MPEG-' + this.version;
    const profileIndex = Common.getBitAllignedNumber(buf, off + 2, 0, 2);
    this.codec = 'AAC';
    this.codecProfile = MPEG4.AudioObjectTypes[profileIndex];

    debug(`MPEG-4 audio-codec=${this.codec}`);

    const samplingFrequencyIndex = Common.getBitAllignedNumber(buf, off + 2, 2, 4);
    this.samplingRate = MPEG4.SamplingFrequencies[samplingFrequencyIndex];
    debug(`sampling-rate=${this.samplingRate}`);

    const channelIndex = Common.getBitAllignedNumber(buf, off + 2, 7, 3);
    this.mp4ChannelConfig = MPEG4_ChannelConfigurations[channelIndex];
    debug(`channel-config=${this.mp4ChannelConfig.join('+')}`);

    this.frameLength = Common.getBitAllignedNumber(buf, off + 3, 6, 2) << 11;
  }

  private calcBitrate(): number {
    if (this.bitrateIndex === 0x00) return null; // free
    if (this.bitrateIndex === 0x0F) return null; // 'reserved'
    const mpegVersion: string = this.version.toString() + this.layer;
    return MpegFrameHeader.bitrate_index[this.bitrateIndex][mpegVersion];
  }

  private calcSamplingRate(): number {
    if (this.sampRateFreqIndex === 0x03) return null; // 'reserved'
    return MpegFrameHeader.sampling_rate_freq_index[this.version][this.sampRateFreqIndex];
  }
}

/**
 * MPEG Audio Layer I/II/III
 */
const FrameHeader = {
  len: 4,

  get: (buf, off): MpegFrameHeader => {
    return new MpegFrameHeader(buf, off);
  }
};

function getVbrCodecProfile(vbrScale: number): string {
  return 'V' + (100 - vbrScale) / 10;
}

export class MpegParser extends AbstractID3Parser {

  private frameCount: number = 0;
  private syncFrameCount: number = -1;
  private countSkipFrameData: number = 0;
  private totalDataLength = 0;

  private audioFrameHeader;
  private bitrates: number[] = [];
  private offset: number;
  private frame_size;
  private crc: number;

  private calculateEofDuration: boolean = false;
  private samplesPerFrame;

  private buf_frame_header = Buffer.alloc(4);

  /**
   * Number of bytes already parsed since beginning of stream / file
   */
  private mpegOffset: number;

  private syncPeek = {
    buf: Buffer.alloc(maxPeekLen),
    len: 0
  };

  /**
   * Called after ID3 headers have been parsed
   */
  public async _parse(): Promise<void> {

    this.metadata.setFormat('lossless', false);

    try {
      let quit = false;
      while (!quit) {
        await this.sync();
        quit = await this.parseCommonMpegHeader();
      }
    } catch (err) {
      if (err.message === endOfFile) {
        if (this.calculateEofDuration) {
          const numberOfSamples = this.frameCount * this.samplesPerFrame;
          this.metadata.setFormat('numberOfSamples', numberOfSamples);
          const duration = numberOfSamples / this.metadata.format.sampleRate;
          debug(`Calculate duration at EOF: ${duration} sec.`, duration);
          this.metadata.setFormat('duration', duration);
        }
      } else {
        throw err;
      }
    }
  }

  /**
   * Called after file has been fully parsed, this allows, if present, to exclude the ID3v1.1 header length
   */
  protected finalize() {

    const format = this.metadata.format;
    const hasID3v1 = this.metadata.native.hasOwnProperty('ID3v1');
    if (format.duration && this.tokenizer.fileSize) {
      const mpegSize = this.tokenizer.fileSize - this.mpegOffset - (hasID3v1 ? 128 : 0);
      if (format.codecProfile && format.codecProfile[0] === 'V') {
        this.metadata.setFormat('bitrate', mpegSize * 8 / format.duration);
      }
    } else if (this.tokenizer.fileSize && format.codecProfile === 'CBR') {
      const mpegSize = this.tokenizer.fileSize - this.mpegOffset - (hasID3v1 ? 128 : 0);
      const numberOfSamples = Math.round(mpegSize / this.frame_size) * this.samplesPerFrame;
      this.metadata.setFormat('numberOfSamples', numberOfSamples);
      const duration = numberOfSamples / format.sampleRate;
      debug("Calculate CBR duration based on file size: %s", duration);
      this.metadata.setFormat('duration', duration);
    }
  }

  private async sync(): Promise<void> {

    let gotFirstSync = false;

    while (true) {
      let bo = 0;
      this.syncPeek.len = await this.tokenizer.peekBuffer(this.syncPeek.buf, 0, maxPeekLen, this.tokenizer.position, true);
      if (this.syncPeek.len <= 256) {
        throw new Error(endOfFile);
      }
      while (true) {
        if (gotFirstSync && (this.syncPeek.buf[bo] & 0xE0) === 0xE0) {
          this.buf_frame_header[0] = MpegFrameHeader.SyncByte1;
          this.buf_frame_header[1] = this.syncPeek.buf[bo];
          await this.tokenizer.ignore(bo);
          debug(`Sync at offset=${this.tokenizer.position - 1}, frameCount=${this.frameCount}`);
          if (this.syncFrameCount === this.frameCount) {
            debug(`Re-synced MPEG stream, frameCount=${this.frameCount}`);
            this.frameCount = 0;
            this.frame_size = 0;
          }
          this.syncFrameCount = this.frameCount;
          return; // sync
        } else {
          gotFirstSync = false;
          bo = this.syncPeek.buf.indexOf(MpegFrameHeader.SyncByte1, bo);
          if (bo === -1) {
            if (this.syncPeek.len < this.syncPeek.buf.length) {
              throw new Error(endOfFile);
            }
            await this.tokenizer.ignore(this.syncPeek.len);
            break; // continue with next buffer
          } else {
            ++bo;
            gotFirstSync = true;
          }
        }
      }
    }
  }

  /**
   * Combined ADTS & MPEG (MP2 & MP3) header handling
   * @return {Promise<boolean>} true if parser should quit
   */
  private async parseCommonMpegHeader(): Promise<boolean> {

    if (this.frameCount === 0) {
      this.mpegOffset = this.tokenizer.position - 1;
    }

    await this.tokenizer.peekBuffer(this.buf_frame_header, 1, 3);

    let header: MpegFrameHeader;
    try {
      header = FrameHeader.get(this.buf_frame_header, 0);
    } catch (err) {
      await this.tokenizer.ignore(1);
      this.metadata.addWarning('Parse error: ' + err.message);
      return false; // sync
    }
    await this.tokenizer.ignore(3);

    this.metadata.setFormat('container', header.container);
    this.metadata.setFormat('codec', header.codec);
    this.metadata.setFormat('lossless', false);
    this.metadata.setFormat('sampleRate', header.samplingRate);

    this.frameCount++;
    if (header.version >= 2 && header.layer === 0) {
      return this.parseAdts(header); // ADTS, usually AAC
    } else {
      return this.parseAudioFrameHeader(header); // MP3
    }
  }

  /**
   * @return {Promise<boolean>} true if parser should quit
   */
  private async parseAudioFrameHeader(header: MpegFrameHeader): Promise<boolean> {

    this.metadata.setFormat('numberOfChannels', header.channelMode === 'mono' ? 1 : 2);
    this.metadata.setFormat('bitrate', header.bitrate);

    if (this.frameCount < 20 * 10000) {
      debug('offset=%s MP%s bitrate=%s sample-rate=%s', this.tokenizer.position - 4, header.layer, header.bitrate, header.samplingRate);
    }
    const slot_size = header.calcSlotSize();
    if (slot_size === null) {
      throw new Error('invalid slot_size');
    }

    const samples_per_frame = header.calcSamplesPerFrame();
    debug(`samples_per_frame=${samples_per_frame}`);
    const bps = samples_per_frame / 8.0;
    const fsize = (bps * header.bitrate / header.samplingRate) +
      ((header.padding) ? slot_size : 0);
    this.frame_size = Math.floor(fsize);

    this.audioFrameHeader = header;
    this.bitrates.push(header.bitrate);

    // xtra header only exists in first frame
    if (this.frameCount === 1) {
      this.offset = FrameHeader.len;
      await this.skipSideInformation();
      return false;
    }

    if (this.frameCount === 3) {
      // the stream is CBR if the first 3 frame bitrates are the same
      if (this.areAllSame(this.bitrates)) {
        // Actual calculation will be done in finalize
        this.samplesPerFrame = samples_per_frame;
        this.metadata.setFormat('codecProfile', 'CBR');
        if (this.tokenizer.fileSize)
          return true; // Will calculate duration based on the file size
      } else if (this.metadata.format.duration) {
        return true; // We already got the duration, stop processing MPEG stream any further
      }
      if (!this.options.duration) {
        return true; // Enforce duration not enabled, stop processing entire stream
      }
    }

    // once we know the file is VBR attach listener to end of
    // stream so we can do the duration calculation when we
    // have counted all the frames
    if (this.options.duration && this.frameCount === 4) {
      this.samplesPerFrame = samples_per_frame;
      this.calculateEofDuration = true;
    }

    this.offset = 4;
    if (header.isProtectedByCRC) {
      await this.parseCrc();
      return false;
    } else {
      await this.skipSideInformation();
      return false;
    }
  }

  private async parseAdts(header: MpegFrameHeader): Promise<boolean> {
    const buf = Buffer.alloc(3);
    await this.tokenizer.readBuffer(buf);
    header.frameLength += Common.getBitAllignedNumber(buf, 0, 0, 11);
    this.tokenizer.ignore(header.frameLength - 7);
    this.totalDataLength += header.frameLength;
    this.samplesPerFrame = 1024;

    const framesPerSec = header.samplingRate / this.samplesPerFrame;
    const bytesPerFrame = this.frameCount === 0 ? 0 : this.totalDataLength / this.frameCount;
    const bitrate = 8 * bytesPerFrame * framesPerSec + 0.5;
    this.metadata.setFormat('codecProfile', header.codecProfile);
    this.metadata.setFormat('bitrate', bitrate);
    if (header.mp4ChannelConfig) {
      this.metadata.setFormat('numberOfChannels', header.mp4ChannelConfig.length);
    }

    debug(`frame-count=${this.frameCount}, size=${header.frameLength} bytes, bit-rate=${bitrate}`);

    // Consume remaining header and frame data
    if (this.frameCount === 3) {
      if (this.options.duration) {
        this.calculateEofDuration = true;
      } else {
        return true; // Stop parsing after the third frame
      }
    }
    return false;
  }

  private async parseCrc(): Promise<void> {
    this.crc = await this.tokenizer.readNumber(Token.INT16_BE);
    this.offset += 2;
    return this.skipSideInformation();
  }

  private async skipSideInformation(): Promise<void> {
    const sideinfo_length = this.audioFrameHeader.calculateSideInfoLength();
    // side information
    await this.tokenizer.readToken(new Token.BufferType(sideinfo_length));
    this.offset += sideinfo_length;
    await this.readXtraInfoHeader();
    return;
  }

  private async readXtraInfoHeader(): Promise<IXingInfoTag> {

    const headerTag = await this.tokenizer.readToken(InfoTagHeaderTag);
    this.offset += InfoTagHeaderTag.len;  // 12

    switch (headerTag) {

      case 'Info':
        this.metadata.setFormat('codecProfile', 'CBR');
        return this.readXingInfoHeader();

      case 'Xing':
        const infoTag = await this.readXingInfoHeader();
        const codecProfile = getVbrCodecProfile(infoTag.vbrScale);
        this.metadata.setFormat('codecProfile', codecProfile);
        return null;

      case 'Xtra':
        // ToDo: ???
        break;

      case 'LAME':
        const version = await this.tokenizer.readToken(LameEncoderVersion);
        this.offset += LameEncoderVersion.len;
        this.metadata.setFormat('tool', 'LAME ' + version);
        await this.skipFrameData(this.frame_size - this.offset);
        return null;
      // ToDo: ???
    }

    // ToDo: promise duration???
    const frameDataLeft = this.frame_size - this.offset;
    if (frameDataLeft < 0) {
      this.metadata.addWarning('Frame ' + this.frameCount + 'corrupt: negative frameDataLeft');
    } else {
      await this.skipFrameData(frameDataLeft);
    }
    return null;

  }

  /**
   * Ref: http://gabriel.mp3-tech.org/mp3infotag.html
   * @returns {Promise<string>}
   */
  private async readXingInfoHeader(): Promise<IXingInfoTag> {

    const infoTag = await this.tokenizer.readToken<IXingInfoTag>(XingInfoTag);
    this.offset += XingInfoTag.len;  // 12

    this.metadata.setFormat('tool', Common.stripNulls(infoTag.codec));

    if ((infoTag.headerFlags[3] & 0x01) === 1) {
      const duration = this.audioFrameHeader.calcDuration(infoTag.numFrames);
      this.metadata.setFormat('duration', duration);
      debug('Get duration from Xing header: %s', this.metadata.format.duration);
      return infoTag;
    }

    // frames field is not present
    const frameDataLeft = this.frame_size - this.offset;

    await this.skipFrameData(frameDataLeft);
    return infoTag;
  }

  private async skipFrameData(frameDataLeft: number): Promise<void> {
    assert.ok(frameDataLeft >= 0, 'frame-data-left cannot be negative');
    await this.tokenizer.readToken(new Token.IgnoreType(frameDataLeft));
    this.countSkipFrameData += frameDataLeft;
  }

  private areAllSame(array) {
    const first = array[0];
    return array.every(element => {
      return element === first;
    });
  }
}
