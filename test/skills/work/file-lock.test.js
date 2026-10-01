import { createFileLock } from '../../../skills/work/lib/file-lock.js';
import { lockTests } from '../../helpers/file-lock-suite.js';
lockTests(createFileLock, 'work');
