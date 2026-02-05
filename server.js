const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const multer = require('multer');
const FormData = require('form-data');
const axios = require('axios');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;
const NETWORK_PATH = '/home/shreegowri/certificate-blockchain/fabric-samples/test-network';
const CHAINCODE_NAME = 'basic'; // Changed from certificate-chaincode-v2 to basic

// Get server's IP address dynamically
function getServerIP() {
    const networkInterfaces = os.networkInterfaces();
    let serverIp = 'localhost';
    
    Object.keys(networkInterfaces).forEach(iface => {
        networkInterfaces[iface].forEach(address => {
            // Look for non-internal IPv4 addresses (skip Docker networks 172.x)
            if (address.family === 'IPv4' && !address.internal && 
                !address.address.startsWith('172.')) {
                serverIp = address.address;
            }
        });
    });
    
    return serverIp;
}

const SERVER_IP = getServerIP();
console.log('🌐 Server IP detected:', SERVER_IP);

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'uploads/certificates/';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'certificate-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|bmp|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'));
        }
    }
});

// Helper function to execute shell commands with proper environment
function executeCommand(command) {
    return new Promise((resolve, reject) => {
        // Set environment variables for the command
        const env = {
            ...process.env,
            PATH: '/home/shreegowri/certificate-blockchain/fabric-samples/bin:' + process.env.PATH,
            FABRIC_CFG_PATH: '/home/shreegowri/certificate-blockchain/fabric-samples/test-network/../config/',
            CORE_PEER_LOCALMSPID: 'Org1MSP',
            CORE_PEER_MSPCONFIGPATH: '/home/shreegowri/certificate-blockchain/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp',
            CORE_PEER_ADDRESS: 'localhost:7051',
            CORE_PEER_TLS_ENABLED: 'true',
            CORE_PEER_TLS_ROOTCERT_FILE: '/home/shreegowri/certificate-blockchain/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt',
            ORDERER_CA: '/home/shreegowri/certificate-blockchain/fabric-samples/test-network/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem'
        };
        
        exec(command, { 
            cwd: NETWORK_PATH,
            env: env
        }, (error, stdout, stderr) => {
            if (error) {
                console.error('Command Error:', error);
                console.error('Stderr:', stderr);
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

// Upload image to IPFS and return hash
async function uploadImageToIPFS(imagePath) {
    try {
        console.log('📤 Uploading image to IPFS:', imagePath);
        
        const formData = new FormData();
        formData.append('file', fs.createReadStream(imagePath));
        
        const response = await axios.post('http://localhost:5001/api/v0/add', formData, {
            headers: {
                ...formData.getHeaders(),
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 30000
        });
        
        console.log('✅ Image uploaded to IPFS successfully. Hash:', response.data.Hash);
        return response.data.Hash;
    } catch (error) {
        console.error('❌ IPFS Upload Error:', error.message);
        throw new Error(`Failed to upload image to IPFS: ${error.message}`);
    }
}

// Download image from IPFS using hash
async function downloadImageFromIPFS(ipfsHash) {
    try {
        console.log('📥 Downloading image from IPFS:', ipfsHash);
        const response = await axios.get(`http://localhost:8081/ipfs/${ipfsHash}`, {
            responseType: 'arraybuffer',
            timeout: 15000
        });
        
        console.log('✅ Image downloaded successfully, size:', response.data.length);
        return Buffer.from(response.data);
    } catch (error) {
        console.error('❌ IPFS Download Error:', error.message);
        throw new Error(`Failed to download image from IPFS: ${error.message}`);
    }
}

// Create a fallback image when IPFS is not available
async function createFallbackImage() {
    const svg = `
    <svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#f8f9fa"/>
        <circle cx="200" cy="150" r="80" fill="#667eea" opacity="0.1"/>
        <text x="200" y="120" text-anchor="middle" font-family="Arial" font-size="18" fill="#667eea">Certificate Image</text>
        <text x="200" y="150" text-anchor="middle" font-family="Arial" font-size="14" fill="#6c757d">Stored on IPFS</text>
        <text x="200" y="180" text-anchor="middle" font-family="Arial" font-size="12" fill="#6c757d">IPFS Hash Retrieved</text>
    </svg>
    `;
    return await sharp(Buffer.from(svg)).png().toBuffer();
}

// Generate PDF with embedded certificate image
async function generateCertificatePDF(certificateData, certificateImageBuffer = null) {
    return new Promise(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margins: {
                    top: 50,
                    bottom: 50,
                    left: 50,
                    right: 50
                }
            });
            const chunks = [];
            
            doc.on('data', chunk => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            // Background and borders
            doc.rect(0, 0, doc.page.width, doc.page.height).fill('#f8f9fa');
            doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40).strokeColor('#2c3e50').lineWidth(2).stroke();
            doc.rect(40, 40, doc.page.width - 80, doc.page.height - 80).strokeColor('#2c3e50').lineWidth(3).stroke();

            let currentY = 60;

            // CERTIFICATE IMAGE SECTION
            if (certificateImageBuffer) {
                try {
                    doc.fillColor('#2c3e50').fontSize(20).font('Helvetica-Bold')
                       .text('CERTIFICATE IMAGE', doc.page.width / 2, currentY, { align: 'center' });
                    currentY += 40;

                    const imageWidth = 400;
                    const imageHeight = 300;
                    const imageX = (doc.page.width - imageWidth) / 2;
                    
                    doc.image(certificateImageBuffer, imageX, currentY, {
                        width: imageWidth,
                        height: imageHeight,
                        fit: [imageWidth, imageHeight]
                    });
                    
                    currentY += imageHeight + 40;
                } catch (imageError) {
                    console.error('Error adding certificate image to PDF:', imageError);
                    currentY += 100;
                }
            } else {
                // If no image, show message
                doc.fillColor('#6c757d').fontSize(16).font('Helvetica')
                   .text('No Certificate Image Available', doc.page.width / 2, currentY + 100, { align: 'center' });
                currentY += 180;
            }

            // Certificate Details Section
            doc.fillColor('#2c3e50').fontSize(24).font('Helvetica-Bold')
               .text('CERTIFICATE OF ACHIEVEMENT', doc.page.width / 2, currentY, { align: 'center' });
            currentY += 50;

            doc.fillColor('#34495e').fontSize(16).font('Helvetica')
               .text('This is to certify that', doc.page.width / 2, currentY, { align: 'center' });
            currentY += 40;

            doc.fillColor('#e74c3c').fontSize(24).font('Helvetica-Bold')
               .text(certificateData.studentName, doc.page.width / 2, currentY, { align: 'center' });
            currentY += 50;

            doc.fillColor('#34495e').fontSize(14).font('Helvetica')
               .text('has successfully completed all requirements and demonstrated exceptional', doc.page.width / 2, currentY, { align: 'center' });
            currentY += 25;
            
            doc.text('performance in the prescribed course of study.', doc.page.width / 2, currentY, { align: 'center' });
            currentY += 50;

            // Details box
            const detailsStartY = currentY;
            const detailsWidth = 300;
            const detailsX = (doc.page.width - detailsWidth) / 2;
            
            doc.rect(detailsX, detailsStartY, detailsWidth, 120).fill('#e7f3ff').strokeColor('#667eea').lineWidth(1).stroke();
            
            doc.fillColor('#2c3e50').fontSize(14).font('Helvetica-Bold')
               .text('Certificate Details', detailsX + 20, detailsStartY + 20);
            
            // FIXED: Handle undefined issuer properly
            const issuerName = certificateData.issuer && certificateData.issuer !== 'undefined' ? certificateData.issuer : "Educational Institution";
            
            doc.fillColor('#34495e').fontSize(11).font('Helvetica')
               .text(`Certificate ID: ${certificateData.certificateId}`, detailsX + 20, detailsStartY + 45)
               .text(`Issued By: ${issuerName}`, detailsX + 20, detailsStartY + 65)
               .text(`Issue Date: ${certificateData.issueDate}`, detailsX + 20, detailsStartY + 85);
            
            if (certificateData.imageIpfsHash) {
                doc.text(`Image IPFS Hash: ${certificateData.imageIpfsHash.substring(0, 20)}...`, detailsX + 20, detailsStartY + 105);
            }

            doc.fillColor('#27ae60').fontSize(12).font('Helvetica-Bold')
               .text('✓ VERIFIED ON HYPERLEDGER FABRIC BLOCKCHAIN', doc.page.width / 2, doc.page.height - 60, { align: 'center' });

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

// Test blockchain connection
async function testBlockchainConnection() {
    try {
        console.log('Testing blockchain connection...');
        const result = await executeCommand(`peer chaincode query -C mychannel -n ${CHAINCODE_NAME} -c '{"function":"GetAllAssets","Args":[]}'`);
        console.log('✅ Blockchain connection successful');
        return true;
    } catch (error) {
        console.error('❌ Blockchain connection failed:', error);
        return false;
    }
}

// API Routes

// Get all certificates from blockchain
app.get('/api/certificates', async (req, res) => {
    try {
        const result = await executeCommand(`peer chaincode query -C mychannel -n ${CHAINCODE_NAME} -c '{"function":"GetAllAssets","Args":[]}'`);
        const assets = JSON.parse(result);
        
        const certificates = assets
            .filter(asset => asset.ID.startsWith('certificate_'))
            .map(asset => {
                let studentName = asset.Color;
                let imageIpfsHash = null;
                
                // Parse the Color field: "studentName|ipfsHash"
                if (asset.Color.includes('|')) {
                    const parts = asset.Color.split('|');
                    studentName = parts[0];
                    imageIpfsHash = parts[1];
                }
                
                // FIXED: Handle undefined issuer properly
                const issuerName = (asset.Owner && asset.Owner !== 'undefined') ? asset.Owner : "Educational Institution";
                
                return {
                    certificateId: asset.ID.replace('certificate_', ''),
                    studentName: studentName,
                    issuer: issuerName,
                    issueDate: '2024-01-01',
                    imageIpfsHash: imageIpfsHash,
                    imageUrl: imageIpfsHash ? `http://${SERVER_IP}:8081/ipfs/${imageIpfsHash}` : null
                };
            });
        
        res.json(certificates);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DEBUG ENDPOINT - ADD THIS
app.post('/api/debug-form', upload.single('certificateImage'), async (req, res) => {
    try {
        console.log('=== DEBUG FORM RECEIVED ===');
        console.log('certificateId:', req.body.certificateId);
        console.log('studentName:', req.body.studentName);
        console.log('issuer:', req.body.issuer);
        console.log('issueDate:', req.body.issueDate);
        console.log('issuer type:', typeof req.body.issuer);
        console.log('issuer empty:', req.body.issuer === '');
        console.log('issuer undefined:', req.body.issuer === undefined);
        console.log('issuer null:', req.body.issuer === null);
        console.log('=== END DEBUG ===');
        
        res.json({
            received: req.body,
            file: req.file ? 'File received: ' + req.file.originalname : 'No file'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Issue new certificate with image upload - COMPLETELY FIXED VERSION
app.post('/api/certificates', upload.single('certificateImage'), async (req, res) => {
    try {
        const { certificateId, studentName, issuer, issueDate } = req.body;
        
        // DEBUG: Log exactly what we receive
        console.log('=== CREATING CERTIFICATE - REQUEST DATA ===');
        console.log('certificateId:', certificateId);
        console.log('studentName:', studentName);
        console.log('issuer:', issuer);
        console.log('issueDate:', issueDate);
        console.log('issuer empty?', issuer === '');
        console.log('issuer undefined?', issuer === undefined);
        console.log('issuer null?', issuer === null);
        console.log('file received?', !!req.file);
        console.log('=== END DEBUG ===');

        if (!certificateId || !studentName || !issuer) {
            console.log('❌ Validation failed - missing required fields');
            return res.status(400).json({ error: 'Certificate ID, Student Name, and Issuer are required' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'Certificate image is required' });
        }

        let imageIpfsHash = null;

        try {
            console.log('🔄 Processing uploaded certificate image...');
            
            // Upload certificate image to IPFS
            imageIpfsHash = await uploadImageToIPFS(req.file.path);
            
            console.log('✅ Certificate image stored on IPFS with hash:', imageIpfsHash);
            
        } catch (imageError) {
            console.error('❌ Certificate image processing error:', imageError);
            if (req.file && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            return res.status(500).json({ error: 'Failed to upload certificate image to IPFS' });
        }

        try {
            // Store certificate data on blockchain
            const assetId = `certificate_${certificateId}`;
            
            // Use simple format: studentName|ipfsHash
            const colorField = `${studentName}|${imageIpfsHash}`;
            
            // FIXED: Proper issuer handling - use the actual issuer from request
            const issuerName = issuer && issuer.trim() !== '' ? issuer : "Educational Institution";
            
            console.log('🔗 Storing on blockchain with issuer:', issuerName);
            
            const createCommand = `peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls --cafile ${path.join(NETWORK_PATH, 'organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem')} -C mychannel -n ${CHAINCODE_NAME} --peerAddresses localhost:7051 --tlsRootCertFiles ${path.join(NETWORK_PATH, 'organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt')} --peerAddresses localhost:9051 --tlsRootCertFiles ${path.join(NETWORK_PATH, 'organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt')} -c '{"function":"CreateAsset","Args":["${assetId}", "${colorField}", "1", "${issuerName}", "100"]}'`;
            
            console.log('Executing blockchain command...');
            await executeCommand(createCommand);
            console.log('✅ Certificate created on blockchain:', assetId);
            
        } catch (blockchainError) {
            console.error('❌ Blockchain error:', blockchainError);
            if (req.file && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            return res.status(500).json({ error: 'Failed to store certificate on blockchain: ' + blockchainError.message });
        }

        // Clean up uploaded file
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        const certificate = {
            certificateId,
            studentName,
            issuer: issuer, // Return the actual issuer sent by frontend
            issueDate: issueDate || new Date().toISOString().split('T')[0],
            imageUploaded: true,
            imageIpfsHash,
            imageUrl: `http://${SERVER_IP}:8081/ipfs/${imageIpfsHash}`,
            pdfUrl: `http://${SERVER_IP}:3000/api/certificates/${certificateId}/pdf`,
            message: 'Certificate image stored on IPFS and data stored on blockchain'
        };
        
        res.status(201).json(certificate);
    } catch (error) {
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: error.message });
    }
});

// Update certificate issuer - NEW ENDPOINT
app.put('/api/certificates/:id/issuer', async (req, res) => {
    try {
        const { issuer } = req.body;
        const certificateId = `certificate_${req.params.id}`;
        
        if (!issuer) {
            return res.status(400).json({ error: 'Issuer name is required' });
        }

        console.log(`🔄 Updating issuer for certificate ${certificateId} to: ${issuer}`);
        
        // First, get the current certificate data
        const result = await executeCommand(`peer chaincode query -C mychannel -n ${CHAINCODE_NAME} -c '{"function":"ReadAsset","Args":["${certificateId}"]}'`);
        const asset = JSON.parse(result);
        
        let studentName = asset.Color;
        let imageIpfsHash = null;
        
        // Parse the Color field to preserve existing data
        if (asset.Color.includes('|')) {
            const parts = asset.Color.split('|');
            studentName = parts[0];
            imageIpfsHash = parts[1];
        }
        
        // Update the certificate with new issuer
        const updateCommand = `peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls --cafile ${path.join(NETWORK_PATH, 'organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem')} -C mychannel -n ${CHAINCODE_NAME} --peerAddresses localhost:7051 --tlsRootCertFiles ${path.join(NETWORK_PATH, 'organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt')} --peerAddresses localhost:9051 --tlsRootCertFiles ${path.join(NETWORK_PATH, 'organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt')} -c '{"function":"UpdateAsset","Args":["${certificateId}", "${asset.Color}", "1", "${issuer}", "100"]}'`;
        
        console.log('Executing update command...');
        await executeCommand(updateCommand);
        console.log('✅ Certificate issuer updated successfully');
        
        res.json({ 
            success: true,
            certificateId: req.params.id,
            oldIssuer: asset.Owner,
            newIssuer: issuer,
            message: 'Issuer updated successfully'
        });
        
    } catch (error) {
        console.error('❌ Error updating issuer:', error);
        res.status(500).json({ error: 'Failed to update issuer: ' + error.message });
    }
});

// Get certificate PDF
app.get('/api/certificates/:id/pdf', async (req, res) => {
    try {
        const certificateId = `certificate_${req.params.id}`;
        const result = await executeCommand(`peer chaincode query -C mychannel -n ${CHAINCODE_NAME} -c '{"function":"ReadAsset","Args":["${certificateId}"]}'`);
        const asset = JSON.parse(result);
        
        console.log('Generating PDF for certificate:', certificateId);
        
        let certificateImageBuffer = null;
        let studentName = asset.Color;
        let imageIpfsHash = null;
        
        // Parse the Color field: "studentName|ipfsHash"
        if (asset.Color.includes('|')) {
            const parts = asset.Color.split('|');
            studentName = parts[0];
            imageIpfsHash = parts[1];
        }
        
        // Download certificate image from IPFS
        if (imageIpfsHash) {
            try {
                console.log('Downloading certificate image from IPFS:', imageIpfsHash);
                certificateImageBuffer = await downloadImageFromIPFS(imageIpfsHash);
            } catch (downloadError) {
                console.error('Error downloading image from IPFS:', downloadError);
                certificateImageBuffer = await createFallbackImage();
            }
        } else {
            console.log('No certificate image IPFS hash found for certificate:', certificateId);
        }
        
        // FIXED: Handle undefined issuer properly
        const issuerName = (asset.Owner && asset.Owner !== 'undefined') ? asset.Owner : "Educational Institution";
        
        const certificateData = {
            certificateId: asset.ID.replace('certificate_', ''),
            studentName: studentName,
            issuer: issuerName,
            issueDate: '2024-01-01',
            imageIpfsHash: imageIpfsHash
        };
        
        const pdfBuffer = await generateCertificatePDF(certificateData, certificateImageBuffer);
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename=certificate-${certificateData.certificateId}.pdf`);
        res.send(pdfBuffer);
        
        console.log('✅ PDF generated successfully for certificate:', certificateId);
        
    } catch (error) {
        console.error('❌ Error generating PDF:', error);
        res.status(404).json({ error: 'Certificate not found or PDF generation failed' });
    }
});

// VERIFY CERTIFICATE - COMPLETELY FIXED VERSION
app.get('/api/verify/:id', async (req, res) => {
    try {
        const certificateId = `certificate_${req.params.id}`;
        console.log('🔍 Verifying certificate:', certificateId);
        
        const result = await executeCommand(`peer chaincode query -C mychannel -n ${CHAINCODE_NAME} -c '{"function":"ReadAsset","Args":["${certificateId}"]}'`);
        const asset = JSON.parse(result);
        
        console.log('📋 Raw asset data from blockchain:', JSON.stringify(asset, null, 2));
        
        let studentName = asset.Color;
        let imageIpfsHash = null;
        
        // Parse the Color field
        if (asset.Color && asset.Color.includes('|')) {
            const parts = asset.Color.split('|');
            studentName = parts[0] || "Unknown Student";
            imageIpfsHash = parts[1] || null;
        }
        
        const hasImage = imageIpfsHash && imageIpfsHash !== 'null' && imageIpfsHash !== 'undefined';
        
        // COMPLETELY FIXED: Handle the string "undefined" issue
        let issuerName = "Educational Institution"; // Default fallback
        
        if (asset.Owner && asset.Owner !== 'undefined' && asset.Owner !== 'null' && asset.Owner.trim() !== '') {
            issuerName = asset.Owner;
        }
        
        console.log('✅ Final issuer name:', issuerName);
        
        const verificationResult = { 
            verified: true,
            certificateId: asset.ID.replace('certificate_', ''),
            studentName: studentName || "Unknown Student",
            issuer: issuerName,
            issueDate: '2024-01-01',
            imageIpfsHash: hasImage ? imageIpfsHash : null,
            imageUrl: hasImage ? `http://${SERVER_IP}:8081/ipfs/${imageIpfsHash}` : null,
            existsOnBlockchain: true,
            timestamp: new Date().toISOString()
        };
        
        console.log('🎉 Verification result:', JSON.stringify(verificationResult, null, 2));
        res.json(verificationResult);
        
    } catch (error) {
        console.error('❌ Verification error:', error);
        res.json({ 
            verified: false,
            existsOnBlockchain: false,
            error: 'Certificate not found on blockchain',
            details: error.message
        });
    }
});

// Get specific certificate details
app.get('/api/certificates/:id', async (req, res) => {
    try {
        const certificateId = `certificate_${req.params.id}`;
        const result = await executeCommand(`peer chaincode query -C mychannel -n ${CHAINCODE_NAME} -c '{"function":"ReadAsset","Args":["${certificateId}"]}'`);
        const asset = JSON.parse(result);
        
        let studentName = asset.Color;
        let imageIpfsHash = null;
        
        // Parse the Color field: "studentName|ipfsHash"
        if (asset.Color.includes('|')) {
            const parts = asset.Color.split('|');
            studentName = parts[0];
            imageIpfsHash = parts[1];
        }
        
        // FIXED: Handle undefined issuer properly
        const issuerName = (asset.Owner && asset.Owner !== 'undefined') ? asset.Owner : "Educational Institution";
        
        const certificate = {
            certificateId: asset.ID.replace('certificate_', ''),
            studentName: studentName,
            issuer: issuerName,
            issueDate: '2024-01-01',
            imageIpfsHash: imageIpfsHash,
            imageUrl: imageIpfsHash ? `http://${SERVER_IP}:8081/ipfs/${imageIpfsHash}` : null
        };
        
        res.json(certificate);
    } catch (error) {
        res.status(404).json({ error: 'Certificate not found' });
    }
});

// Test endpoint to check blockchain connection
app.get('/api/test-blockchain', async (req, res) => {
    try {
        const isConnected = await testBlockchainConnection();
        if (isConnected) {
            res.json({ 
                status: 'connected', 
                message: 'Blockchain connection successful',
                serverIp: SERVER_IP,
                accessUrls: {
                    local: `http://localhost:${PORT}`,
                    network: `http://${SERVER_IP}:${PORT}`
                }
            });
        } else {
            res.status(500).json({ status: 'error', message: 'Blockchain connection failed' });
        }
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
    console.log('=== CERTIFICATE IMAGE STORAGE SYSTEM ===');
    console.log('Server running on port', PORT);
    console.log('🔗 Flow: Image → IPFS Hash → Blockchain → PDF with Image');
    console.log('');
    console.log('📋 Available Endpoints:');
    console.log('  POST /api/certificates          - Upload certificate image & store on blockchain');
    console.log('  POST /api/debug-form            - Debug form data reception');
    console.log('  GET  /api/certificates          - List all certificates');
    console.log('  GET  /api/certificates/:id      - Get specific certificate details');
    console.log('  PUT  /api/certificates/:id/issuer - Update certificate issuer');
    console.log('  GET  /api/certificates/:id/pdf  - Get PDF with certificate image');
    console.log('  GET  /api/verify/:id            - Verify certificate');
    console.log('  GET  /api/test-blockchain       - Test connection');
    console.log('');
    console.log('🚀 Ready to process certificate images!');
    console.log('');
    console.log('🌐 **ACCESS URLs:**');
    console.log(`   Local access:    http://localhost:${PORT}`);
    console.log(`   Network access:  http://${SERVER_IP}:${PORT}`);
    console.log(`   IPFS Gateway:    http://${SERVER_IP}:8081`);
    console.log('');
    console.log('✅ UPDATED: Using basic chaincode instead of certificate-chaincode-v2');
    console.log('✅ FIXED: Enhanced issuer field handling with detailed debugging');
    console.log('✅ FIXED: Dynamic IP addressing for multi-machine access');
    console.log('✅ FEATURE: Server auto-detects IP address');
    
    // Display all network interfaces
    console.log('\n🌐 Network Interfaces:');
    const networkInterfaces = os.networkInterfaces();
    Object.keys(networkInterfaces).forEach(iface => {
        networkInterfaces[iface].forEach(address => {
            if (address.family === 'IPv4' && !address.internal) {
                console.log(`   ${iface}: ${address.address}`);
            }
        });
    });
    
    // Test blockchain connection on startup
    testBlockchainConnection();
});
