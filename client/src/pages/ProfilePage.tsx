import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { Camera, KeyRound, Save, ShieldCheck, UserRound } from 'lucide-react';
import { PageHeader } from '../components/PageHeader.js';
import { initials } from '../lib/format.js';
import { assetUrl } from '../lib/assets.js';
import { useAuth } from '../store/auth.js';

export function ProfilePage() {
  const { user, updateProfile, uploadProfileImage, changePassword } = useAuth();
  const fields = user?.record.fields ?? {};
  const [name, setName] = useState(text(fields.name, user?.name ?? ''));
  const [phone, setPhone] = useState(text(fields.phone));
  const [whatsappNumber, setWhatsappNumber] = useState(text(fields.whatsapp_number ?? fields.whatsapp ?? fields.whatsapp_no ?? fields.whatsapp_phone));
  const [address, setAddress] = useState(text(fields.address));
  const [emergencyContact, setEmergencyContact] = useState(text(fields.emergency_contact));
  const [bio, setBio] = useState(text(fields.bio));
  const [dateOfBirth, setDateOfBirth] = useState(text(fields.date_of_birth ?? fields.dob));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  useEffect(() => {
    const next = user?.record.fields ?? {};
    setName(text(next.name, user?.name ?? ''));
    setPhone(text(next.phone));
    setWhatsappNumber(text(next.whatsapp_number ?? next.whatsapp ?? next.whatsapp_no ?? next.whatsapp_phone));
    setAddress(text(next.address));
    setEmergencyContact(text(next.emergency_contact));
    setBio(text(next.bio));
    setDateOfBirth(text(next.date_of_birth ?? next.dob));
  }, [user]);

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setProfileError(null);
    setProfileMessage(null);
    try {
      await updateProfile({ name: name.trim(), phone: phone.trim() || null, whatsapp_number: whatsappNumber.trim() || null, address: address.trim() || null, emergency_contact: emergencyContact.trim() || null, bio: bio.trim() || null, date_of_birth: dateOfBirth || null });
      setProfileMessage('Your profile details have been updated.');
    } catch (problem) {
      setProfileError(problem instanceof Error ? problem.message : 'Unable to update your profile.');
    } finally {
      setSaving(false);
    }
  };

  const saveImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setProfileError(null);
    setProfileMessage(null);
    try {
      await uploadProfileImage(file);
      setProfileMessage('Profile image updated.');
    } catch (problem) {
      setProfileError(problem instanceof Error ? problem.message : 'Unable to upload your profile image.');
    } finally {
      setUploading(false);
    }
  };

  const savePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword.length < 8) {
      setPasswordError('Use at least 8 characters for the new password.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('The new password confirmation does not match.');
      return;
    }
    setChangingPassword(true);
    setPasswordError(null);
    setPasswordMessage(null);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordMessage('Your password was changed successfully.');
    } catch (problem) {
      setPasswordError(problem instanceof Error ? problem.message : 'Unable to change your password.');
    } finally {
      setChangingPassword(false);
    }
  };

  const avatarUrl = profileImage(fields);
  return <>
    <PageHeader eyebrow="MY ACCOUNT" title="Profile & security" description="Keep your contact details, work WhatsApp number, profile image and login password up to date." />
    <section className="profile-settings-layout">
      <article className="content-card profile-identity-card">
        <div className="card-heading"><div><p className="eyebrow">PROFILE IMAGE</p><h2>Your workspace identity</h2></div><UserRound size={20} /></div>
        <div className="profile-avatar-editor">
          {avatarUrl ? <img src={avatarUrl} alt={`${name || user?.name || 'Your'} profile`} /> : <span>{initials(name || user?.name)}</span>}
          <label className="button button--secondary file-action"><Camera size={16} /> {uploading ? 'Uploading…' : 'Change photo'}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void saveImage(event)} disabled={uploading} /></label>
        </div>
        <div className="profile-identity-meta"><strong>{user?.name}</strong><span>{user?.role}</span><small>{user?.email}</small></div>
        <p className="profile-photo-note">PNG, JPG, or WEBP up to 5 MB.</p>
      </article>
      <article className="content-card profile-details-card">
        <div className="card-heading"><div><p className="eyebrow">PERSONAL DETAILS</p><h2>Contact information</h2></div><Save size={20} /></div>
        <form onSubmit={(event) => void saveProfile(event)}>
          <div className="form-grid">
            <label className="field"><span>Full name *</span><input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={120} required /></label>
            <label className="field"><span>Phone</span><input value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={32} inputMode="tel" /></label>
            <label className="field"><span>Date of birth *</span><input type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} required /></label>
            <label className="field field--wide"><span>Work WhatsApp number</span><input value={whatsappNumber} onChange={(event) => setWhatsappNumber(event.target.value)} maxLength={32} inputMode="tel" placeholder="+91 98765 43210" /><small>This is used for work notifications.</small></label>
            <label className="field field--wide"><span>Address</span><textarea value={address} onChange={(event) => setAddress(event.target.value)} rows={3} maxLength={1000} /></label>
            <label className="field"><span>Emergency contact</span><input value={emergencyContact} onChange={(event) => setEmergencyContact(event.target.value)} maxLength={120} /></label>
            <label className="field field--wide"><span>About / bio</span><textarea value={bio} onChange={(event) => setBio(event.target.value)} rows={3} maxLength={1000} /></label>
          </div>
          {profileError && <p className="form-error">{profileError}</p>}{profileMessage && <p className="form-success">{profileMessage}</p>}
          <div className="modal-actions"><button className="button" type="submit" disabled={saving || uploading}><Save size={16} /> {saving ? 'Saving…' : 'Save profile'}</button></div>
        </form>
      </article>
    </section>
    <section className="profile-security-layout" id="security">
      <article className="content-card profile-security-card">
        <div className="card-heading"><div><p className="eyebrow">LOGIN SECURITY</p><h2>Change password</h2></div><ShieldCheck size={20} /></div>
        <p className="muted-copy">Use your current password to set a new private password. Passwords are never displayed or recoverable.</p>
        <form onSubmit={(event) => void savePassword(event)}><div className="form-grid"><label className="field field--wide"><span>Current password *</span><input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></label><label className="field"><span>New password *</span><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} maxLength={128} required /></label><label className="field"><span>Confirm new password *</span><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} maxLength={128} required /></label></div>{passwordError && <p className="form-error">{passwordError}</p>}{passwordMessage && <p className="form-success">{passwordMessage}</p>}<div className="modal-actions"><button className="button" type="submit" disabled={changingPassword}><KeyRound size={16} /> {changingPassword ? 'Changing…' : 'Change password'}</button></div></form>
      </article>
    </section>
  </>;
}

function text(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value);
}

function profileImage(fields: Record<string, unknown>): string | null {
  for (const value of [fields.profile_image_url, fields.avatar_url, fields.profile_photo_url, fields.photo_url]) {
    const source = assetUrl(value);
    if (source) return source;
  }
  return null;
}
