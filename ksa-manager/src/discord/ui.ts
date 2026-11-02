import {
  ButtonStyle,
  ComponentType,
  TextInputStyle,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APILabelComponent,
  type APIModalInteractionResponseCallbackData,
  type APISelectMenuOption,
  type APIStringSelectComponent,
  type APITextInputComponent,
  type APIUserSelectComponent,
} from 'discord.js';
import { BRAND, COLORS } from '../domain/constants.js';
import { truncate } from '../util/text.js';

export type Row = APIActionRowComponent<APIComponentInMessageActionRow>;

export function button(
  customId: string,
  label: string,
  style: ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Success | ButtonStyle.Danger = ButtonStyle.Secondary,
  disabled = false,
): APIButtonComponent {
  return { type: ComponentType.Button, custom_id: customId, label: truncate(label, 80), style, disabled };
}

export function linkButton(url: string, label: string): APIButtonComponent {
  return { type: ComponentType.Button, url, label: truncate(label, 80), style: ButtonStyle.Link };
}

export function row(...components: APIComponentInMessageActionRow[]): Row {
  return { type: ComponentType.ActionRow, components };
}

export function stringSelect(
  customId: string,
  placeholder: string,
  options: APISelectMenuOption[],
  minValues = 1,
  maxValues = 1,
): APIStringSelectComponent {
  return {
    type: ComponentType.StringSelect,
    custom_id: customId,
    placeholder: truncate(placeholder, 150),
    options: options.slice(0, 25).map((o) => ({ ...o, label: truncate(o.label, 100), description: o.description ? truncate(o.description, 100) : undefined })),
    min_values: minValues,
    max_values: Math.min(maxValues, options.length, 25),
  };
}

export function userSelect(customId: string, placeholder: string): APIUserSelectComponent {
  return { type: ComponentType.UserSelect, custom_id: customId, placeholder, min_values: 1, max_values: 1 };
}

export interface TextFieldSpec {
  id: string;
  label: string;
  description?: string;
  style?: 'short' | 'paragraph';
  required?: boolean;
  placeholder?: string;
  value?: string;
  minLength?: number;
  maxLength: number;
}

function textInput(f: TextFieldSpec): APITextInputComponent {
  const input: APITextInputComponent = {
    type: ComponentType.TextInput,
    custom_id: f.id,
    style: f.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short,
    required: f.required ?? true,
    max_length: f.maxLength,
  };
  if (f.minLength !== undefined) input.min_length = f.minLength;
  if (f.placeholder) input.placeholder = truncate(f.placeholder, 100);
  if (f.value) input.value = truncate(f.value, f.maxLength);
  return input;
}

export interface SelectFieldSpec {
  id: string;
  label: string;
  description?: string;
  options: APISelectMenuOption[];
  required?: boolean;
}

/** Modal mit Label-Komponenten (aktueller Discord-Standard; max. 5 Felder). */
export function modal(customId: string, title: string, fields: (TextFieldSpec | SelectFieldSpec)[]): APIModalInteractionResponseCallbackData {
  if (fields.length < 1 || fields.length > 5) throw new Error('Modals erlauben 1–5 Felder');
  const components: APILabelComponent[] = fields.map((f) => {
    const label: APILabelComponent = {
      type: ComponentType.Label,
      label: truncate(f.label, 45),
      component:
        'options' in f
          ? {
              type: ComponentType.StringSelect,
              custom_id: f.id,
              options: f.options.slice(0, 25),
              min_values: f.required === false ? 0 : 1,
              max_values: 1,
              required: f.required ?? true,
            }
          : textInput(f),
    };
    if (f.description) label.description = truncate(f.description, 100);
    return label;
  });
  return { custom_id: customId, title: truncate(title, 45), components };
}

export interface EmbedOptions {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: string;
  timestamp?: number;
  logoUrl?: string | undefined;
}

/** Einheitliches Embed: dunkles Discord-Design, rote Akzentfarbe, klare Texte. */
export function embed(o: EmbedOptions): APIEmbed {
  const e: APIEmbed = { color: o.color ?? COLORS.accent };
  if (o.title) e.title = truncate(o.title, 256);
  if (o.description) e.description = truncate(o.description, 4096);
  if (o.fields?.length) {
    e.fields = o.fields.slice(0, 25).map((f) => ({
      name: truncate(f.name, 256),
      value: truncate(f.value || '–', 1024),
      inline: f.inline ?? false,
    }));
  }
  e.footer = { text: truncate(o.footer ?? BRAND, 2048) };
  if (o.logoUrl) e.thumbnail = { url: o.logoUrl };
  if (o.timestamp !== undefined) e.timestamp = new Date(o.timestamp).toISOString();
  return e;
}

export { ButtonStyle };
