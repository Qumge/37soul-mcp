import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { profileDir, StoreError } from './store.js';
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
export interface RegistrationAvatar {
    filename: string;
    content_type: string;
    data_base64: string;
}
function imageType(b: Buffer): {
    mime: string;
    extension: string;
} | null {
    if (b.length >= 45 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        let offset = 8, idat: Buffer[] = [];
        let width = 0, height = 0, ended = false;
        while (offset + 12 <= b.length) {
            const n = b.readUInt32BE(offset);
            if (n > b.length - offset - 12)
                return null;
            const tag = b.toString('ascii', offset + 4, offset + 8);
            const data = b.subarray(offset + 8, offset + 8 + n);
            if (offset === 8) {
                if (tag !== 'IHDR' || n !== 13)
                    return null;
                width = data.readUInt32BE(0);
                height = data.readUInt32BE(4);
                if (!width || !height || width * height > 25000000)
                    return null;
            }
            if (tag === 'IDAT')
                idat.push(data);
            offset += n + 12;
            if (tag === 'IEND') {
                ended = n === 0 && offset === b.length;
                break;
            }
        }
        if (!ended || !idat.length)
            return null;
        try {
            if (!inflateSync(Buffer.concat(idat), { maxOutputLength: 64 * 1024 * 1024 }).length)
                return null;
        }
        catch {
            return null;
        }
        return { mime: 'image/png', extension: 'png' };
    }
    if (b.length > 20 && b[0] === 255 && b[1] === 216 && b[b.length - 2] === 255 && b[b.length - 1] === 217) {
        let i = 2, frame = false;
        while (i + 3 < b.length) {
            if (b[i++] !== 255)
                return null;
            while (b[i] === 255)
                i++;
            const marker = b[i++];
            if (marker === 0xda)
                break;
            if (marker === 0xd9)
                break;
            if (marker >= 0xd0 && marker <= 0xd7)
                continue;
            const n = b.readUInt16BE(i);
            if (n < 2 || i + n > b.length)
                return null;
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
                if (n < 8 || !b.readUInt16BE(i + 3) || !b.readUInt16BE(i + 5))
                    return null;
                frame = true;
            }
            i += n;
        }
        if (frame)
            return { mime: 'image/jpeg', extension: 'jpg' };
    }
    if (b.length >= 26 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' && b.readUInt32LE(4) + 8 === b.length && ['VP8 ', 'VP8L', 'VP8X'].includes(b.toString('ascii', 12, 16)))
        return { mime: 'image/webp', extension: 'webp' };
    return null;
}
export async function readAvatarFile(file: string | undefined): Promise<{
    bytes: Buffer;
    mime: string;
    extension: string;
}> {
    if (!file)
        throw new StoreError('invalid_avatar', 'a photo is required; supply --avatar <photo.jpg> (JPEG, PNG or WebP, up to 5 MiB)');
    let bytes: Buffer;
    try {
        const s = await stat(file);
        if (!s.isFile() || s.size === 0 || s.size > MAX_AVATAR_BYTES)
            throw Error('size');
        bytes = await readFile(file);
    }
    catch {
        throw new StoreError('invalid_avatar', 'photo must be a readable non-empty image file, up to 5 MiB');
    }
    if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES)
        throw new StoreError('invalid_avatar', 'photo must be no larger than 5 MiB');
    const kind = imageType(bytes);
    if (!kind)
        throw new StoreError('invalid_avatar', 'photo must be a valid JPEG, PNG or WebP image');
    return { bytes, ...kind };
}
export async function preserveAvatar(root: string, profile: string, file: string | undefined): Promise<string> {
    const image = await readAvatarFile(file);
    const dir = path.join(profileDir(root, profile), 'avatars');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const target = path.join(dir, createHash('sha256').update(image.bytes).digest('hex') + '.' + image.extension);
    await writeFile(target, image.bytes, { mode: 0o600 });
    await chmod(target, 0o600);
    return target;
}
export async function registrationAvatar(file: string | undefined): Promise<RegistrationAvatar> { const image = await readAvatarFile(file); return { filename: 'avatar.' + image.extension, content_type: image.mime, data_base64: image.bytes.toString('base64') }; }
