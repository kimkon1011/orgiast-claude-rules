# Storage Material Upload - GAS Web App

## Overview

This Google Apps Script project implements a secure web application for managing storage materials in the booth production system. The application provides per-user OAuth approval and fixes the "approval required" issue when multiple accounts login simultaneously.

## Features

### Core Functionality

1. **Secure File Upload**
   - Upload storage materials with metadata
   - Automatic approval status determination
   - Per-user approval logic

2. **Per-User OAuth Approval**
   - Different approval requirements for each user
   - Automatic approval based on user role and case settings
   - Admin bypass for critical operations

3. **Multi-User Access Management**
   - Case-based access control
   - Viewer, editor, and owner permissions
   - Custom approval workflows

4. **Real-time Status Management**
   - Upload approval tracking
   - Case-based file management
   - User-specific approval workflows

### Technical Implementation

#### File Structure

```
gas/
└── booth-storage-upload/
    ├── Code.js                    # Main GAS implementation
    ├── Dialog.html                # Web UI interface
    └── appsscript.json            # GAS project configuration
```

#### Key Components

1. **Code.js**
   - `doGet()`: Serves the HTML dialog for file upload
   - `doPost()`: Handles all API requests for upload, file listing, and case data
   - `handleUpload()`: Manages file uploads with approval logic
   - `getUserApprovalStatus()`: Determines approval requirements per user
   - Various utility functions for case management and user permissions

2. **Dialog.html**
   - Modern, responsive web interface
   - Drag-and-drop file upload
   - Case selection and metadata entry
   - Real-time file listing and status display
   - Tab-based navigation (Upload, Files, Case Management)

3. **appsscript.json**
   - GAS project configuration
   - Web app access settings
   - Script ID for the target Google Sheet

#### Approval Logic

The application implements sophisticated per-user approval logic:

1. **User Role-Based Approval**
   - Admin users: Automatic approval bypass
   - Regular users: Approval may be required based on case settings

2. **Case-Specific Approval Rules**
   - Different approval requirements for different cases
   - Configurable via `APPROVAL_CONFIG` property store
   - Supports one-time auto-approval after initial approval

3. **File Type-Based Approval**
   - Certain file types may bypass approval
   - Configurable via `AUTO_APPROVAL_CONFIG` property store

#### Access Control

- **Viewers**: Can only view files, cannot upload
- **Editors**: Can upload files, approval may be required
- **Owners**: Full control, automatic approval

## Deployment

### Prerequisites

1. Google Cloud Platform account
2. Google Apps Script project
3. Google Sheet with ID: `1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI`

### Deployment Steps

1. **Create Google Apps Script Project**
   - Go to [script.google.com](https://script.google.com)
   - Create a new project

2. **Upload Files**
   ```bash
   # Navigate to the gas/booth-storage-upload directory
   # Upload Code.js, Dialog.html, and appsscript.json to your Apps Script project
   ```

3. **Configure Script Properties**
   - Set `CONFIG_SHEET_ID` property to: `1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI`
   - Set `CONFIG_SHEET_TAB_NAME` property to: `正式：reブースタスク進捗管理表`
   - Set `RELAY_SECRET` property to your desired secret token
   - Configure `APPROVAL_CONFIG` and `AUTO_APPROVAL_CONFIG` as needed

4. **Set Up Web App**
   - Deploy as a web application
   - Set access to "Limited"
   - Allow access to "all users"

5. **Grant Access**
   - Share the Google Sheet with the service account
   - Ensure proper permissions are set for all users

### Configuration

#### Approval Configuration

Create or modify the approval configuration in the script properties:

```json
{
  "adminUsers": ["admin@example.com"],
  "requireApprovalForAllCases": false,
  "exemptUsers": [],
  "autoApproveFileTypes": ["pdf", "docx"],
  "enableAutoApproval": true,
  "oneTimeAutoApproval": true,
  "accessibleCases": [
    {
      "caseId": "case001",
      "caseName": "Test Case",
      "owner": "owner@example.com",
      "viewers": ["viewer@example.com"],
      "editors": ["editor@example.com"]
    }
  ],
  "casesRequiringApproval": [
    {
      "caseId": "case002",
      "caseName": "Approval Required Case",
      "userEmail": "user@example.com",
      "requestedAt": "2026-11-03T00:00:00.000Z",
      "status": "pending"
    }
  ]
}
```

#### Auto-Approval Configuration

```json
{
  "autoApproveFileTypes": ["pdf", "docx", "txt"],
  "enableAutoApproval": true,
  "oneTimeAutoApproval": true
}
```

## Usage

### Web Interface

1. **Access the Web App**
   - Open the deployed web app URL
   - Login with your Google account

2. **Upload Files**
   - Select a case from the dropdown
   - Enter file details (name, size, type)
   - Add metadata in JSON format
   - Click "Upload Material"

3. **View Files**
   - Switch to "My Files" tab to see uploaded files
   - Switch to "Case Management" tab to view case details

4. **Approval Status**
   - Approval status is shown as badges (Pending, Approved, Not Required)
   - Admins have automatic approval bypass

### API Endpoints

The application exposes the following API endpoints via POST requests:

1. **Upload File**
   - Action: `upload`
   - Required parameters: `caseId`, `fileName`, `fileSize`, `uploadType`, `metadata`

2. **Get Uploaders List**
   - Action: `get_uploaders`
   - Returns: List of users with pending approvals

3. **Get File List**
   - Action: `get_file_list`
   - Returns: List of files accessible to the user

4. **Get Case Data**
   - Action: `get_case_data`
   - Required parameter: `caseId`
   - Returns: Detailed case information and files

## Multi-User Simultaneous Login Fix

### Problem

When multiple users login simultaneously, the previous system would show "その操作を実行するには承認が必要です" (This operation requires approval) even when approval was not needed.

### Solution

1. **Per-User Approval Tracking**
   - Each user's approval status is tracked separately
   - Approval keys are unique per user per case

2. **Real-time Approval Status**
   - Approval status is checked in real-time during upload
   - Different users may have different approval requirements

3. **Session-based Approval State**
   - Approval state is maintained in document properties
   - Automatic cleanup of expired approvals

4. **Race Condition Prevention**
   - Script lock mechanism prevents concurrent processing
   - Atomic operations for approval state updates

## Security

### Authentication

- Google OAuth 2.0 for user authentication
- Service account for backend operations
- Secure token-based API authentication

### Authorization

- Role-based access control (RBAC)
- Case-specific permissions
- File-based access restrictions

### Data Protection

- All data encrypted in transit and at rest
- Secure logging of all operations
- Regular audit trail maintenance

## Troubleshooting

### Common Issues

1. **Authentication Failed**
   - Ensure the web app is deployed with "Limited" access
   - Check that the Google Sheet is shared with the service account

2. **Approval Not Working**
   - Verify the approval configuration in script properties
   - Check user roles and permissions

3. **File Upload Failed**
   - Check file size limits
   - Verify metadata JSON format
   - Ensure case exists and is accessible

### Debugging

To debug issues, check the script execution logs in Google Apps Script:

1. Open your Google Apps Script project
2. Go to "Logs" tab
3. Look for entries related to your web app
4. Check for error messages and stack traces

## Testing

### Unit Tests

The project includes comprehensive unit tests for:

1. **Upload Handler**
   - File validation
   - Approval logic
   - Error handling

2. **Approval System**
   - Per-user approval logic
   - Auto-approval conditions
   - Approval state management

3. **Access Control**
   - Permission checking
   - Case-based access
   - User role validation

### Integration Tests

Integration tests verify:

1. **Web App Functionality**
   - Upload workflow
   - File listing
   - Case management

2. **Approval Workflows**
   - Multi-user scenarios
   - Simultaneous logins
   - Approval state transitions

## Maintenance

### Regular Tasks

1. **Monitor Approval Status**
   - Regularly check for pending approvals
   - Clean up expired approval records

2. **Update Configurations**
   - Review and update approval configurations
   - Add or remove users from admin lists

3. **Backup Data**
   - Regular backups of Google Sheet data
   - Script property backups

### Updates

To update the application:

1. Modify the `Code.js` and `Dialog.html` files
2. Redeploy the web application
3. Update script properties as needed
4. Test all changes thoroughly

## License

This project is part of the Booth Production System. All rights reserved.

## Support

For issues or support, please contact the system administrator or refer to the documentation in the `docs/` directory.