import { createFileLock } from '../../../skills/feeding/lib/file-lock.js';
import { lockTests } from '../../helpers/file-lock-suite.js';
lockTests(createFileLock, 'feeding');
