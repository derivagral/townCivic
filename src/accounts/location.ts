/** A location choice is separate from notification consent and from browsing town. */
export interface ReaderLocation {
  status: 'unset' | 'provided' | 'declined';
  jurisdiction: string | null;
  street: string | null;
  updatedAt: string | null;
}

export type LocationInput =
  { status: 'provided'; jurisdiction: string; street: string } | { status: 'unset' | 'declined' };

export const EMPTY_LOCATION: ReaderLocation = {
  status: 'unset',
  jurisdiction: null,
  street: null,
  updatedAt: null,
};

/** Validate in the store as well as the form; other callers share this contract. */
export function normalizeLocation(input: LocationInput): ReaderLocation {
  if (input.status === 'unset' || input.status === 'declined') {
    return { ...EMPTY_LOCATION, status: input.status, updatedAt: new Date().toISOString() };
  }
  if (input.status !== 'provided') throw new Error('Choose a valid street preference.');
  const street = input.street.trim().replace(/\s+/g, ' ');
  const jurisdiction = input.jurisdiction.trim();
  if (!street || street.length > 160 || !jurisdiction || jurisdiction.length > 80) {
    throw new Error('Choose a town and enter a street name of up to 160 characters.');
  }
  return { status: 'provided', jurisdiction, street, updatedAt: new Date().toISOString() };
}
