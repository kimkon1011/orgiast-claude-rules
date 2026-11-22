#!/bin/bash  
  
if [ "$1" == "--help" ]; then  
    echo "Usage: ./start.sh [options]";  
    echo "";  
    echo "Options:";  
    echo "  --help     Show this help message and exit";  
    echo "";  
    echo "Description:";  
    echo "  This script starts the auto session management.";  
    exit 0;  
fi;  
  
echo "Starting auto session management..." 
