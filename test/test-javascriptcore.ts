import { assert } from 'chai';
import path from 'node:path';

import { samplePath } from './util.js';
import { Parsers } from "./metadata-parsers.js";

describe('JavaScriptCore', () => {
  const mp3SamplePath = path.join(samplePath, 'mp3');
  const filePath = path.join(mp3SamplePath, 'lame-peak.mp3');

  describe('should parse mp3s correctly', () => {
    Parsers.forEach((parser) => {
      it(parser.description, async function () {
        const { format, common } = await parser.initParser(() => this.skip(), filePath);
        assert.isNotNull(format, 'format');
        assert.isNotNull(common, 'common');
      });
    });
  });
});
