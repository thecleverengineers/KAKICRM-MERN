export const CUSTOM_INVOICE_UNIT = 'Custom';

export const INVOICE_UNITS = [
  'Piece (PCS)',
  'Number (NOS)',
  'Set',
  'Pair',
  'Box',
  'Pack',
  'Bundle',
  'Kilogram (KG)',
  'Gram (G)',
  'Litre (LTR)',
  'Millilitre (ML)',
  'Metre (MTR)',
  'Square Metre (SQM)',
  'Square Feet (SQ FT)',
  'Hour (HR)',
  'Day',
  'Month',
  'Job',
  'Service',
  'Trip',
  'License',
  'Project',
  'Lot',
  CUSTOM_INVOICE_UNIT
] as const;

export function isPresetInvoiceUnit(value: string): boolean {
  return value !== CUSTOM_INVOICE_UNIT && (INVOICE_UNITS as readonly string[]).includes(value);
}

export function unitSelection(value: string): string {
  return isPresetInvoiceUnit(value) ? value : CUSTOM_INVOICE_UNIT;
}

export function resolvedUnit(selectedUnit: string, customUnit: string): string {
  return selectedUnit === CUSTOM_INVOICE_UNIT ? customUnit.trim() : selectedUnit;
}
