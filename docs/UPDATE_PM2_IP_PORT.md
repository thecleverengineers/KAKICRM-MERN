# Replaced by the HTTPS domain deployment guide

KAKI CRM production deployments now use
[`https://www.kakicrm.store/`](https://www.kakicrm.store/) rather than a
public IP address and port. The Node process listens privately on `127.0.0.1`
and Nginx manages the public HTTPS site, API and Socket.IO connections.

Follow [UPDATE_PM2_DOMAIN.md](UPDATE_PM2_DOMAIN.md) for the complete aaPanel/
Nginx, PM2 and HTTPS deployment command.
