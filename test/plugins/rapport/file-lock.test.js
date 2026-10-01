import { createFileLock } from '../../../plugins/rapport/lib/file-lock.js';
import { lockTests } from '../../helpers/file-lock-suite.js';
lockTests(createFileLock, 'rapport');
