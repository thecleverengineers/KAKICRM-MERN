import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return <div className="empty-state page-not-found"><strong>That page does not exist.</strong><span>The link may be outdated, or you may not have access to this area.</span><Link className="button" to="/dashboard">Back to dashboard</Link></div>;
}
