import { createFileLock } from '../../../plugins/currency/lib/file-lock.js';
import { lockTests } from '../../helpers/file-lock-suite.js';
lockTests(createFileLock, 'currency');
