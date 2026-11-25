// OpenBCI Cyton + Daisy: 16 channels at 125 Hz. The same serial protocol as the Cyton (./openbci-cyton.ts): the
// board sends its channels on odd sample numbers and the Daisy's on even ones; the driver pairs them. The Daisy is
// found from the 'v' banner ("On Daisy …"); when the banner does not name it, 'C' asks the board to attach it.

import type { ByteTransport, Driver } from '../contract.ts';
import { makeCytonDriver } from './openbci-cyton.ts';

export const openbciCytonDaisy: Driver<ByteTransport> = makeCytonDriver(true);
